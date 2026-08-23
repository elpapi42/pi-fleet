import { Router, capability } from "zeromq"
import { startPi, type PiProcess } from "../pi/runtime.js"
import { decodeEventCursor, openStore, type AgentRecord } from "../state/store.js"
import {
  decode,
  encode,
  type SendRequest,
  type SendResponse,
  type StatusRequest,
  type StatusResponse,
  type SubscribeRequest,
  type SubscribeResponse,
  type SubscriptionStatusRequest,
  type SubscriptionStatusResponse,
  type UnsubscribeRequest,
  type UnsubscribeResponse,
  type WorkerMessage,
} from "./protocol.js"
import { LiveActivity } from "./activity.js"

type Arguments = { stateDir: string; agentId: string; generation: string }
type WorkerRequest = StatusRequest | SendRequest | SubscribeRequest | UnsubscribeRequest | SubscriptionStatusRequest
type WorkerResponse = StatusResponse | SendResponse | SubscribeResponse | UnsubscribeResponse | SubscriptionStatusResponse
type Outbound = { route: Buffer; message: WorkerMessage; subscriptionId?: string }

async function main(): Promise<void> {
  const { stateDir, agentId, generation } = parseArguments(process.argv.slice(2))
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")

  const store = await openStore(stateDir)
  const record = store.getById(agentId)
  if (!record || record.runtime?.generation !== generation || !record.runtime.endpoint) throw new Error("Worker claim is no longer current")

  const router = new Router({ mandatory: true, immediate: true, linger: 0, sendTimeout: 50 })
  let routerClosed = false
  let state = record.state
  let pi: PiProcess | undefined
  let stateUpdates = Promise.resolve()
  let outbound = Promise.resolve()
  let eventOperations = Promise.resolve()
  const handlers = new Set<Promise<void>>()
  const controlFrames: Outbound[] = []
  const activity = new LiveActivity(record.id, generation)

  const closeRouter = () => {
    if (routerClosed) return
    routerClosed = true
    activity.close()
    router.close()
  }
  const stop = () => closeRouter()
  const queueStateUpdate = (nextState: "working" | "idle") => {
    stateUpdates = stateUpdates.then(async () => {
      const updated = await store.updateState(agentId, generation, nextState)
      if (!updated) {
        closeRouter()
        return
      }
      state = nextState
    }).catch(() => closeRouter())
  }
  const nextOutbound = (): Outbound | undefined => controlFrames.shift() ?? activity.nextOutbound()
  const drainOutbound = async () => {
    while (!routerClosed) {
      const next = nextOutbound()
      if (!next) return
      try {
        await router.send([next.route, encode(next.message)])
      } catch (error) {
        if (next.subscriptionId) activity.deliveryFailed(next.subscriptionId)
        else if (!isUnreachablePeer(error)) throw error
      }
    }
  }
  const scheduleOutbound = () => {
    outbound = outbound.then(drainOutbound).catch(() => closeRouter())
  }
  const reply = (route: Buffer, response: WorkerResponse) => {
    controlFrames.push({ route: Buffer.from(route), message: response })
    scheduleOutbound()
  }
  const queueEventOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = eventOperations.then(operation)
    eventOperations = result.then(() => undefined, () => undefined)
    return result
  }
  const onPiEvent = (event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === "agent_start") queueStateUpdate("working")
    if (event.type === "agent_settled") queueStateUpdate("idle")
    const normalized = activity.normalizePiEvent(event)
    if (!normalized) return
    void queueEventOperation(async () => {
      const appended = await store.appendEvent(agentId, generation, (cursor) => ({ ...normalized, cursor }))
      if (!appended) {
        closeRouter()
        return
      }
      if (activity.publishEvent(appended.sequence, appended.event)) scheduleOutbound()
    }).catch(() => closeRouter())
  }

  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await router.bind(record.runtime.endpoint)
    pi = await startPi({ cwd: record.cwd, piArgs: record.piArgs, sessionPath: record.sessionPath }, 10_000, onPiEvent)
    pi.process.once("exit", closeRouter)
    const markedReady = await store.markReady(agentId, generation, {
      workerPid: process.pid,
      endpoint: record.runtime.endpoint,
      sessionPath: pi.state.sessionFile,
      sessionId: pi.state.sessionId,
    })
    if (!markedReady) throw new Error("Worker claim is no longer current")
    state = "idle"

    for await (const [route, frame] of router) {
      const handler = handleRequest(route, frame, record, generation, pi, () => state, reply, activity, store, queueEventOperation, scheduleOutbound, () => outbound)
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
    await pi?.stop()
    await Promise.allSettled(handlers)
    await stateUpdates
    await eventOperations
    await outbound
    await store.close()
  }
}

async function handleRequest(
  route: Buffer,
  frame: Buffer,
  record: AgentRecord,
  generation: string,
  pi: PiProcess,
  getState: () => AgentRecord["state"],
  reply: (route: Buffer, response: WorkerResponse) => void,
  activity: LiveActivity,
  store: Awaited<ReturnType<typeof openStore>>,
  queueEventOperation: <T>(operation: () => Promise<T>) => Promise<T>,
  scheduleOutbound: () => void,
  currentOutbound: () => Promise<void>,
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

  if (request.command === "subscribe") {
    const subscription = await queueEventOperation(async () => {
      const current = store.getById(record.id)
      if (!current || current.runtime?.generation !== generation) return undefined
      const tail = current.lastEventSeq
      const afterSequence = receiveAfterSequence(request, record.id, tail)
      const subscriptionId = activity.subscribe(route, afterSequence < tail)
      return { subscriptionId, afterSequence, tail }
    }).catch((error) => error)

    if (subscription instanceof Error) {
      reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId: record.id, runtimeGeneration: generation, error: subscription.message, errorCode: "invalid-cursor" })
      return
    }
    if (!subscription) {
      reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId: record.id, runtimeGeneration: generation, error: "Worker claim is no longer current" })
      return
    }

    reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: true, agentId: record.id, runtimeGeneration: generation, subscriptionId: subscription.subscriptionId })
    if (subscription.afterSequence < subscription.tail) {
      await replaySubscription(store, activity, subscription.subscriptionId, record.id, subscription.afterSequence, subscription.tail, scheduleOutbound, currentOutbound)
    }
    return
  }

  if (request.command === "unsubscribe") {
    activity.unsubscribe(route, request.subscriptionId)
    reply(route, { version: 1, requestId: request.requestId, command: "unsubscribe", ok: true, agentId: record.id, runtimeGeneration: generation, subscriptionId: request.subscriptionId })
    return
  }

  if (request.command === "subscription.status") {
    const ok = activity.hasSubscription(route, request.subscriptionId)
    reply(route, {
      version: 1,
      requestId: request.requestId,
      command: "subscription.status",
      ok,
      agentId: record.id,
      runtimeGeneration: generation,
      subscriptionId: request.subscriptionId,
      ...(ok ? {} : { error: "Subscription is no longer active" }),
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

function receiveAfterSequence(request: SubscribeRequest, agentId: string, tail: number): number {
  if (request.fromStart === true && request.after !== undefined) throw new Error("fromStart and after cannot be combined")
  if (request.fromStart === true) return 0
  if (request.after === undefined) return tail
  const cursor = decodeEventCursor(request.after)
  if (cursor.agentId !== agentId || cursor.sequence > tail) throw new Error("Invalid event cursor")
  return cursor.sequence
}

async function replaySubscription(
  store: Awaited<ReturnType<typeof openStore>>,
  activity: LiveActivity,
  subscriptionId: string,
  agentId: string,
  afterSequence: number,
  tail: number,
  scheduleOutbound: () => void,
  currentOutbound: () => Promise<void>,
): Promise<void> {
  const batchSize = 32
  let sequence = afterSequence
  while (sequence < tail) {
    const entries = store.readEvents<import("../fleet/agent.js").AgentEvent>(agentId, sequence, tail, batchSize)
    if (entries.length === 0) throw new Error("Event journal is incomplete")
    for (const entry of entries) {
      if (entry.sequence !== sequence + 1) throw new Error("Event journal is incomplete")
      if (!activity.queueReplay(subscriptionId, entry)) return
      sequence = entry.sequence
    }
    scheduleOutbound()
    await currentOutbound()
  }
  if (activity.finishReplay(subscriptionId)) scheduleOutbound()
}

function decodeRequest(frame: Buffer): WorkerRequest | undefined {
  try {
    const request = decode(frame)
    if (!isRecord(request) || request.version !== 1 || typeof request.requestId !== "string" || typeof request.agentId !== "string" || typeof request.runtimeGeneration !== "string") return undefined
    if (request.command === "status") return request as StatusRequest
    if (request.command === "send" && typeof request.message === "string" && typeof request.delivery === "string") return request as SendRequest
    if (request.command === "subscribe" && (request.fromStart === undefined || typeof request.fromStart === "boolean") &&
      (request.after === undefined || typeof request.after === "string")) return request as SubscribeRequest
    if (request.command === "unsubscribe" && (request.subscriptionId === undefined || typeof request.subscriptionId === "string")) return request as UnsubscribeRequest
    if (request.command === "subscription.status" && typeof request.subscriptionId === "string") return request as SubscriptionStatusRequest
  } catch {}
  return undefined
}

function invalidResponse(request: WorkerRequest | undefined, agentId: string, generation: string): WorkerResponse {
  if (request?.command === "send") return sendResponse(request, agentId, generation, "Worker identity does not match the request")
  if (request?.command === "subscribe") return { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId, runtimeGeneration: generation, error: "Worker identity does not match the request" }
  if (request?.command === "unsubscribe") return { version: 1, requestId: request.requestId, command: "unsubscribe", ok: false, agentId, runtimeGeneration: generation, subscriptionId: request.subscriptionId, error: "Worker identity does not match the request" }
  if (request?.command === "subscription.status") return { version: 1, requestId: request.requestId, command: "subscription.status", ok: false, agentId, runtimeGeneration: generation, subscriptionId: request.subscriptionId, error: "Worker identity does not match the request" }
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
