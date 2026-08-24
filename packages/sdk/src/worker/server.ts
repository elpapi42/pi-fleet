import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { Router, capability } from "zeromq"
import { type PiState } from "../pi/runtime.js"
import { type UnsequencedAgentEvent } from "../fleet/agent.js"
import { decodeEventCursor, encodeEventCursor, openStore, type AgentRecord } from "../state/store.js"
import {
  decode,
  encode,
  type DestroyRequest,
  type DestroyResponse,
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
import { PiSupervisor, SupervisorSendFailure, type SupervisorSendError } from "./supervisor.js"

type Arguments = { stateDir: string; agentId: string; generation: string; claimId?: string }
type WorkerRequest = StatusRequest | SendRequest | DestroyRequest | SubscribeRequest | UnsubscribeRequest | SubscriptionStatusRequest
type WorkerResponse = StatusResponse | SendResponse | DestroyResponse | SubscribeResponse | UnsubscribeResponse | SubscriptionStatusResponse
type Outbound = { route: Buffer; message: WorkerMessage; subscriptionId?: string }

class InvalidEventCursorRequestError extends Error {}

async function main(): Promise<void> {
  const { stateDir, agentId, generation, claimId } = parseArguments(process.argv.slice(2))
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")

  const store = await openStore(stateDir)
  const record = store.getById(agentId)
  if (!record || record.runtime?.generation !== generation || !record.runtime.endpoint || (claimId && record.runtime.claimId !== claimId)) throw new Error("Worker claim is no longer current")

  const router = new Router({ mandatory: true, immediate: true, linger: 0, sendTimeout: 50 })
  let routerClosed = false
  let state = record.state
  let workActive = record.state === "working"
  let destroying = false
  let supervisor: PiSupervisor | undefined
  let fenceTimer: NodeJS.Timeout | undefined
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
  const ownsClaim = () => {
    const current = store.getById(agentId)
    return !current?.destroying && current?.runtime?.generation === generation && (!claimId || current.runtime.claimId === claimId)
  }
  const ownsDestroy = () => {
    const marker = store.getById(agentId)?.destroying
    return marker?.runtimeGeneration === generation && marker.claimId === claimId
  }
  const fence = () => {
    if (destroying || ownsClaim() || ownsDestroy()) return true
    closeRouter()
    void supervisor?.stop()
    return false
  }
  const queueStateUpdate = (nextState: "working" | "idle") => {
    void queueEventOperation(async () => {
      const updated = await store.updateState(agentId, generation, nextState)
      if (!updated) {
        if (!ownsDestroy()) closeRouter()
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
  const appendSemanticEvents = async (events: readonly UnsequencedAgentEvent[]): Promise<boolean> => {
    for (const event of events) {
      const appended = await store.appendEvent(agentId, generation, (cursor) => ({ ...event, cursor }))
      if (!appended) {
        if (!ownsDestroy()) closeRouter()
        return false
      }
      if (activity.publishEvent(appended.sequence, appended.event)) scheduleOutbound()
    }
    return true
  }
  const onPiEvent = (event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === "agent_start") {
      workActive = true
      queueStateUpdate("working")
    }
    if (event.type === "agent_settled") {
      workActive = false
      queueStateUpdate("idle")
    }
    const normalized = activity.normalizePiEvent(event)
    if (normalized.length === 0) return
    void queueEventOperation(() => appendSemanticEvents(normalized)).catch(() => closeRouter())
  }

  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await router.bind(record.runtime.endpoint)
    supervisor = new PiSupervisor({
      initial: record,
      generation,
      onPiEvent,
      beforeRecovery: async () => {
        const interrupted = workActive
        workActive = false
        await queueEventOperation(async () => {
          if (interrupted && !(await appendSemanticEvents([{
            type: "work.interrupted",
            eventId: randomUUID(),
            activityId: randomUUID(),
            timestamp: Date.now(),
          }]))) throw new Error("Worker claim is no longer current")
          activity.resetPiActivity()
        })
      },
      loadRecord: () => {
        const current = store.getById(agentId)
        return current && !current.destroying && ownsClaim() ? current : undefined
      },
      onRecovered: async (piState) => {
        if (!ownsClaim()) return false
        return markRecovered(store, agentId, generation, piState, (next) => {
          state = next
          workActive = false
        })
      },
      onRecoveryFailed: async () => {
        await Promise.resolve()
        await outbound
        closeRouter()
      },
    })
    if (!fence()) throw new Error("Worker claim is no longer current")
    const initialState = await supervisor.start()
    if (!fence()) throw new Error("Worker claim is no longer current")
    const ready = {
      workerPid: process.pid,
      endpoint: record.runtime.endpoint,
      sessionPath: initialState.sessionFile,
      sessionId: initialState.sessionId,
    }
    const markedReady = claimId
      ? await store.markClaimReady(agentId, generation, claimId, ready)
      : await store.markReady(agentId, generation, ready)
    if (!markedReady) throw new Error("Worker claim is no longer current")
    state = "idle"
    fenceTimer = setInterval(fence, 1_000)

    for await (const [route, frame] of router) {
      if (!fence()) break
      const handler = handleRequest(route, frame, record, generation, claimId, supervisor, () => state, () => destroying, () => { destroying = true }, reply, closeRouter, activity, store, queueEventOperation, scheduleOutbound, () => outbound)
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
    if (fenceTimer) clearInterval(fenceTimer)
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    closeRouter()
    await supervisor?.stop()
    await Promise.allSettled(handlers)
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
  claimId: string | undefined,
  supervisor: PiSupervisor,
  getState: () => AgentRecord["state"],
  isDestroying: () => boolean,
  markDestroying: () => void,
  reply: (route: Buffer, response: WorkerResponse) => void,
  closeRouter: () => void,
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
  if (isDestroying()) {
    reply(route, destroyingResponse(request, record.id, generation))
    return
  }

  if (request.command === "destroy") {
    try {
      await supervisor.prepareDestroy()
      const destroyed = await queueEventOperation(() => store.beginDestroy(record.id, record.name, {
        runtimeGeneration: generation,
        claimId: claimId ?? "",
        requestedAt: Date.now(),
      }, (cursor) => ({
        type: "agent.destroyed" as const,
        cursor,
        eventId: randomUUID(),
        activityId: randomUUID(),
        timestamp: Date.now(),
      })))
      if (!destroyed) {
        reply(route, destroyResponse(request, record.id, generation, "Agent is unavailable"))
        return
      }
      markDestroying()
      if (activity.publishEvent(destroyed.event.sequence, destroyed.event.event)) scheduleOutbound()
      if (activity.endSubscriptions()) scheduleOutbound()
      await currentOutbound()
      await supervisor.stop()
      await rm(ipcPath(record.runtime?.endpoint), { force: true })
      const owner = destroyed.record.destroying!
      while ((await store.deleteDestroyEventBatch(record.id, owner, 128)) === 128) {}
      if (!(await store.finishDestroy(record.id, owner))) throw new Error("Destroy cleanup did not complete")
      reply(route, destroyResponse(request, record.id, generation))
      await currentOutbound()
      closeRouter()
    } catch (error) {
      reply(route, destroyResponse(request, record.id, generation, error instanceof Error ? error.message : String(error)))
    }
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
    let subscription: { subscriptionId: string; afterSequence: number; tail: number } | undefined
    try {
      subscription = await queueEventOperation(async () => {
        const current = store.getById(record.id)
        if (!current || current.runtime?.generation !== generation) return undefined
        const tail = current.lastEventSeq
        const afterSequence = receiveAfterSequence(request, record.id, tail)
        const subscriptionId = activity.subscribe(route, afterSequence < tail)
        return { subscriptionId, afterSequence, tail }
      })
    } catch (error) {
      if (!(error instanceof InvalidEventCursorRequestError)) throw error
      reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId: record.id, runtimeGeneration: generation, error: error.message, errorCode: "invalid-cursor" })
      return
    }

    if (!subscription) {
      reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId: record.id, runtimeGeneration: generation, error: "Worker claim is no longer current" })
      return
    }

    reply(route, {
      version: 1,
      requestId: request.requestId,
      command: "subscribe",
      ok: true,
      agentId: record.id,
      runtimeGeneration: generation,
      subscriptionId: subscription.subscriptionId,
      afterSequence: subscription.afterSequence,
      ...(subscription.afterSequence > 0 ? { resumeCursor: encodeEventCursor(record.id, subscription.afterSequence) } : {}),
    })
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
    const acceptedAt = await supervisor.send(request.message, request.delivery, request.deadlineAt)
    reply(route, sendResponse(request, record.id, generation, undefined, acceptedAt))
  } catch (error) {
    const code = error instanceof SupervisorSendFailure ? error.code : undefined
    const message = code ? sendErrorMessage(code) : error instanceof Error ? error.message : String(error)
    reply(route, sendResponse(request, record.id, generation, message, undefined, code))
  }
}

function receiveAfterSequence(request: SubscribeRequest, agentId: string, tail: number): number {
  if (request.fromStart !== undefined && request.after !== undefined) throw new InvalidEventCursorRequestError("fromStart and after cannot be combined")
  if (request.fromStart === true) return 0
  if (request.after === undefined) return tail
  try {
    const cursor = decodeEventCursor(request.after)
    if (cursor.agentId !== agentId || cursor.sequence > tail) throw new InvalidEventCursorRequestError("Invalid event cursor")
    return cursor.sequence
  } catch (error) {
    if (error instanceof InvalidEventCursorRequestError) throw error
    throw new InvalidEventCursorRequestError("Invalid event cursor")
  }
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
    if (request.command === "destroy") return request as DestroyRequest
    if (request.command === "send" && typeof request.message === "string" && typeof request.delivery === "string" &&
      typeof request.deadlineAt === "number" && Number.isSafeInteger(request.deadlineAt) && request.deadlineAt > 0) return request as SendRequest
    if (request.command === "subscribe" && (request.fromStart === undefined || request.fromStart === true) &&
      (request.after === undefined || typeof request.after === "string")) return request as SubscribeRequest
    if (request.command === "unsubscribe" && (request.subscriptionId === undefined || typeof request.subscriptionId === "string")) return request as UnsubscribeRequest
    if (request.command === "subscription.status" && typeof request.subscriptionId === "string") return request as SubscriptionStatusRequest
  } catch {}
  return undefined
}

function invalidResponse(request: WorkerRequest | undefined, agentId: string, generation: string): WorkerResponse {
  if (request?.command === "destroy") return destroyResponse(request, agentId, generation, "Worker identity does not match the request")
  if (request?.command === "send") return sendResponse(request, agentId, generation, "Worker identity does not match the request")
  if (request?.command === "subscribe") return { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId, runtimeGeneration: generation, error: "Worker identity does not match the request" }
  if (request?.command === "unsubscribe") return { version: 1, requestId: request.requestId, command: "unsubscribe", ok: false, agentId, runtimeGeneration: generation, subscriptionId: request.subscriptionId, error: "Worker identity does not match the request" }
  if (request?.command === "subscription.status") return { version: 1, requestId: request.requestId, command: "subscription.status", ok: false, agentId, runtimeGeneration: generation, subscriptionId: request.subscriptionId, error: "Worker identity does not match the request" }
  return { version: 1, requestId: request?.requestId ?? "", ok: false, error: "Worker identity does not match the request" }
}

function destroyingResponse(request: WorkerRequest, agentId: string, generation: string): WorkerResponse {
  if (request.command === "destroy") return destroyResponse(request, agentId, generation, "Agent is unavailable")
  return invalidResponse(request, agentId, generation)
}

function destroyResponse(request: DestroyRequest, agentId: string, generation: string, error?: string): DestroyResponse {
  return {
    version: 1,
    requestId: request.requestId,
    command: "destroy",
    ok: error === undefined,
    agentId,
    runtimeGeneration: generation,
    ...(error === undefined ? {} : { error }),
  }
}

function sendResponse(request: SendRequest, agentId: string, generation: string, error?: string, acceptedAt?: number, errorCode?: SupervisorSendError): SendResponse {
  return {
    version: 1,
    requestId: request.requestId,
    command: "send",
    ok: error === undefined,
    agentId,
    runtimeGeneration: generation,
    ...(error === undefined ? { acceptedAt } : { error, ...(errorCode === undefined ? {} : { errorCode }) }),
  }
}

async function markRecovered(store: Awaited<ReturnType<typeof openStore>>, agentId: string, generation: string, piState: PiState, setState: (state: "idle") => void): Promise<boolean> {
  const recovered = await store.markRecovered(agentId, generation, { sessionPath: piState.sessionFile, sessionId: piState.sessionId })
  if (recovered) setState("idle")
  return recovered
}

function sendErrorMessage(error: SupervisorSendError | undefined): string {
  if (error === "recovery-queue-full") return "Agent recovery queue is full"
  if (error === "send-uncertain") return "Instruction may have been accepted by Pi"
  if (error === "send-expired") return "Instruction expired before it reached Pi"
  return "Agent is unavailable"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function ipcPath(endpoint: string | undefined): string {
  if (!endpoint?.startsWith("ipc://")) throw new Error("Worker endpoint is not an ipc path")
  return endpoint.slice("ipc://".length)
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
  const claimId = values.get("--claim")
  if (!stateDir || !agentId || !generation) throw new Error("Worker requires --state-dir, --agent, and --generation")
  return { stateDir, agentId, generation, ...(claimId ? { claimId } : {}) }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
