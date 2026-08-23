import { Router, capability } from "zeromq"
import { createStateDirectories } from "./paths.js"
import { decode, encode, type SendRequest, type SendResponse, type StatusRequest, type StatusResponse } from "./protocol.js"
import { startPi, type PiProcess } from "./pi-rpc.js"
import { openRegistry, type AgentRecord } from "./registry.js"

type Arguments = { stateDir: string; agentId: string; generation: string }
type WorkerRequest = StatusRequest | SendRequest

async function main(): Promise<void> {
  const { stateDir, agentId, generation } = parseArguments(process.argv.slice(2))
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")

  const registry = await openRegistry(stateDir)
  const record = registry.getById(agentId)
  if (!record || record.runtime?.generation !== generation || !record.runtime.endpoint) throw new Error("Worker claim is no longer current")

  await createStateDirectories(stateDir)
  const router = new Router({ mandatory: true, immediate: true, linger: 0, sendTimeout: 1_000 })
  let routerClosed = false
  let state = record.state
  let pi: PiProcess | undefined
  let stateUpdates = Promise.resolve()
  let replies = Promise.resolve()
  const handlers = new Set<Promise<void>>()

  const closeRouter = () => {
    if (routerClosed) return
    routerClosed = true
    router.close()
  }
  const stop = () => closeRouter()
  const queueStateUpdate = (nextState: "working" | "idle") => {
    stateUpdates = stateUpdates.then(async () => {
      const updated = await registry.updateState(agentId, generation, nextState)
      if (!updated) {
        closeRouter()
        return
      }
      state = nextState
    }).catch(() => closeRouter())
  }
  const queueReply = (route: Buffer, response: StatusResponse | SendResponse) => {
    replies = replies.then(async () => {
      try {
        await router.send([route, encode(response)])
      } catch (error: unknown) {
        if (!isUnreachablePeer(error)) throw error
      }
    }).catch(() => closeRouter())
  }
  const onPiEvent = (event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === "agent_start") queueStateUpdate("working")
    if (event.type === "agent_settled") queueStateUpdate("idle")
  }

  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await router.bind(record.runtime.endpoint)
    pi = await startPi(record, 10_000, onPiEvent)
    pi.process.once("exit", closeRouter)
    const markedReady = await registry.markReady(agentId, generation, {
      workerPid: process.pid,
      endpoint: record.runtime.endpoint,
      sessionPath: pi.state.sessionFile,
      sessionId: pi.state.sessionId,
    })
    if (!markedReady) throw new Error("Worker claim is no longer current")
    state = "idle"

    for await (const [route, frame] of router) {
      const handler = handleRequest(route, frame, record, generation, pi, () => state, queueReply)
      handlers.add(handler)
      void handler.then(
        () => handlers.delete(handler),
        () => {
          handlers.delete(handler)
          closeRouter()
        },
      )
    }
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    pi?.process.off("exit", closeRouter)
    closeRouter()
    await stopPi(pi?.process)
    await Promise.allSettled(handlers)
    await stateUpdates
    await replies
    await registry.close()
  }
}

async function handleRequest(
  route: Buffer,
  frame: Buffer,
  record: AgentRecord,
  generation: string,
  pi: PiProcess,
  getState: () => AgentRecord["state"],
  reply: (route: Buffer, response: StatusResponse | SendResponse) => void,
): Promise<void> {
  const request = decodeRequest(frame)
  if (!request || request.agentId !== record.id || request.runtimeGeneration !== generation) {
    reply(route, invalidResponse(request, record.id, generation))
    return
  }

  if (request.command === "status") {
    reply(route, {
      version: 1,
      requestId: request.requestId,
      ok: true,
      status: { id: record.id, name: record.name, runtimeGeneration: generation, state: getState() },
    })
    return
  }

  if (!request.message.trim()) {
    reply(route, sendResponse(request, record.id, generation, "Message must not be empty"))
    return
  }
  if (request.delivery !== "steer" && request.delivery !== "followUp") {
    reply(route, sendResponse(request, record.id, generation, "Invalid delivery"))
    return
  }

  try {
    await pi.send(request.message, request.delivery)
    reply(route, sendResponse(request, record.id, generation, undefined, Date.now()))
  } catch (error) {
    reply(route, sendResponse(request, record.id, generation, error instanceof Error ? error.message : String(error)))
  }
}

function decodeRequest(frame: Buffer): WorkerRequest | undefined {
  try {
    const request = decode(frame)
    if (!isRecord(request) || request.version !== 1 || typeof request.requestId !== "string" || typeof request.agentId !== "string" || typeof request.runtimeGeneration !== "string") return undefined
    if (request.command === "status") return request as StatusRequest
    if (request.command === "send" && typeof request.message === "string" && typeof request.delivery === "string") return request as SendRequest
  } catch {}
  return undefined
}

function invalidResponse(request: WorkerRequest | undefined, agentId: string, generation: string): StatusResponse | SendResponse {
  if (request?.command === "send") return sendResponse(request, agentId, generation, "Worker identity does not match the request")
  return { version: 1, requestId: request?.requestId ?? "", ok: false, error: "Worker identity does not match the request" }
}

function sendResponse(request: SendRequest, agentId: string, generation: string, error?: string, acceptedAt?: number): SendResponse {
  return {
    version: 1,
    requestId: request.requestId,
    command: "send",
    ok: error === undefined,
    agentId,
    runtimeGeneration: generation,
    ...(error === undefined ? { acceptedAt } : { error }),
  }
}

async function stopPi(pi: PiProcess["process"] | undefined): Promise<void> {
  if (!pi || pi.exitCode !== null || pi.signalCode !== null) return
  pi.kill("SIGTERM")
  if (await waitForExit(pi, 1_000)) return
  pi.kill("SIGKILL")
  await waitForExit(pi, 1_000)
}

async function waitForExit(pi: PiProcess["process"], timeoutMs: number): Promise<boolean> {
  if (pi.exitCode !== null || pi.signalCode !== null) return true
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pi.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    pi.once("exit", onExit)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUnreachablePeer(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: string }).code === "EHOSTUNREACH" || (error as { code?: string }).code === "EAGAIN")
}

function parseArguments(args: string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1])
  const stateDir = values.get("--state-dir")
  const agentId = values.get("--agent")
  const generation = values.get("--generation")
  if (!stateDir || !agentId || !generation) throw new Error("Worker requires --state-dir, --agent, and --generation")
  return { stateDir, agentId, generation }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
