import { Router, capability } from "zeromq"
import { createStateDirectories } from "./paths.js"
import { decode, encode, type StatusRequest, type StatusResponse } from "./protocol.js"
import { startPi } from "./pi-rpc.js"
import { openRegistry } from "./registry.js"

type Arguments = { stateDir: string; agentId: string; generation: string }

async function main(): Promise<void> {
  const { stateDir, agentId, generation } = parseArguments(process.argv.slice(2))
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")

  const registry = await openRegistry(stateDir)
  const record = registry.getById(agentId)
  if (!record || record.runtime?.generation !== generation || !record.runtime.endpoint) throw new Error("Worker claim is no longer current")

  await createStateDirectories(stateDir)
  const router = new Router({ mandatory: true, immediate: true, linger: 0, sendTimeout: 1_000 })
  let routerClosed = false
  const closeRouter = () => {
    if (routerClosed) return
    routerClosed = true
    router.close()
  }
  let pi: Awaited<ReturnType<typeof startPi>> | undefined
  const stop = () => closeRouter()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await router.bind(record.runtime.endpoint)
    pi = await startPi(record)
    pi.process.once("exit", closeRouter)
    const markedReady = await registry.markReady(agentId, generation, {
      workerPid: process.pid,
      endpoint: record.runtime.endpoint,
      sessionPath: pi.state.sessionFile,
      sessionId: pi.state.sessionId,
    })
    if (!markedReady) throw new Error("Worker claim is no longer current")

    for await (const [route, frame] of router) {
      const response = statusResponse(frame, agentId, generation, record.name)
      try {
        await router.send([route, encode(response)])
      } catch (error: unknown) {
        if (!isUnreachablePeer(error)) throw error
      }
    }
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    pi?.process.off("exit", closeRouter)
    closeRouter()
    await stopPi(pi?.process)
    await registry.close()
  }
}

async function stopPi(pi: Awaited<ReturnType<typeof startPi>>["process"] | undefined): Promise<void> {
  if (!pi || pi.exitCode !== null || pi.signalCode !== null) return
  pi.kill("SIGTERM")
  if (await waitForExit(pi, 1_000)) return
  pi.kill("SIGKILL")
  await waitForExit(pi, 1_000)
}

async function waitForExit(pi: Awaited<ReturnType<typeof startPi>>["process"], timeoutMs: number): Promise<boolean> {
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

function statusResponse(frame: Buffer, agentId: string, generation: string, name: string): StatusResponse {
  try {
    const request = decode(frame) as StatusRequest
    if (request.version !== 1 || request.command !== "status" || request.agentId !== agentId || request.runtimeGeneration !== generation) {
      return { version: 1, requestId: request?.requestId ?? "", ok: false, error: "Worker identity does not match the request" }
    }
    return { version: 1, requestId: request.requestId, ok: true, status: { id: agentId, name, runtimeGeneration: generation, state: "idle" } }
  } catch {
    return { version: 1, requestId: "", ok: false, error: "Invalid request" }
  }
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
