import { randomUUID } from "node:crypto"
import { Router, capability } from "zeromq"
import { type AgentEvent } from "../fleet/agent.js"
import { startPi, type PiProcess } from "../pi/runtime.js"
import { openStore, type AgentRecord } from "../state/store.js"
import {
  decode,
  encode,
  type EventFrame,
  type SendRequest,
  type SendResponse,
  type StatusRequest,
  type StatusResponse,
  type SubscribeRequest,
  type SubscribeResponse,
  type UnsubscribeRequest,
  type UnsubscribeResponse,
  type WorkerMessage,
} from "./protocol.js"

type Arguments = { stateDir: string; agentId: string; generation: string }
type WorkerRequest = StatusRequest | SendRequest | SubscribeRequest | UnsubscribeRequest
type WorkerResponse = StatusResponse | SendResponse | SubscribeResponse | UnsubscribeResponse
type Subscriber = { route: Buffer; subscriptionId: string; events: EventFrame[] }
type Outbound = { route: Buffer; message: WorkerMessage; subscriptionId?: string }

const SUBSCRIBER_QUEUE_LIMIT = 128

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
  const handlers = new Set<Promise<void>>()
  const controlFrames: Outbound[] = []
  const subscribers = new Map<string, Subscriber>()

  const closeRouter = () => {
    if (routerClosed) return
    routerClosed = true
    subscribers.clear()
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
  const nextOutbound = (): Outbound | undefined => {
    const control = controlFrames.shift()
    if (control) return control
    for (const subscriber of subscribers.values()) {
      const event = subscriber.events.shift()
      if (event) return { route: subscriber.route, message: event, subscriptionId: subscriber.subscriptionId }
    }
    return undefined
  }
  const drainOutbound = async () => {
    while (!routerClosed) {
      const next = nextOutbound()
      if (!next) return
      try {
        await router.send([next.route, encode(next.message)])
      } catch (error) {
        if (next.subscriptionId) subscribers.delete(next.subscriptionId)
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
  const subscribe = (route: Buffer): string => {
    const subscriptionId = randomUUID()
    subscribers.set(subscriptionId, { route: Buffer.from(route), subscriptionId, events: [] })
    return subscriptionId
  }
  const unsubscribe = (route: Buffer, subscriptionId: string) => {
    const subscriber = subscribers.get(subscriptionId)
    if (subscriber?.route.equals(route)) subscribers.delete(subscriptionId)
  }
  const publish = (event: AgentEvent) => {
    for (const subscriber of subscribers.values()) {
      if (subscriber.events.length >= SUBSCRIBER_QUEUE_LIMIT) {
        subscribers.delete(subscriber.subscriptionId)
        continue
      }
      subscriber.events.push({
        version: 1,
        command: "event",
        agentId: record.id,
        runtimeGeneration: generation,
        subscriptionId: subscriber.subscriptionId,
        event,
      })
    }
    scheduleOutbound()
  }
  const normalizeEvent = createEventNormalizer()
  const onPiEvent = (event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === "agent_start") queueStateUpdate("working")
    if (event.type === "agent_settled") queueStateUpdate("idle")
    const normalized = normalizeEvent(event)
    if (normalized) publish(normalized)
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
      const handler = handleRequest(route, frame, record, generation, pi, () => state, reply, subscribe, unsubscribe)
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
  subscribe: (route: Buffer) => string,
  unsubscribe: (route: Buffer, subscriptionId: string) => void,
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
    const subscriptionId = subscribe(route)
    reply(route, { version: 1, requestId: request.requestId, command: "subscribe", ok: true, agentId: record.id, runtimeGeneration: generation, subscriptionId })
    return
  }

  if (request.command === "unsubscribe") {
    unsubscribe(route, request.subscriptionId)
    reply(route, { version: 1, requestId: request.requestId, command: "unsubscribe", ok: true, agentId: record.id, runtimeGeneration: generation, subscriptionId: request.subscriptionId })
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

function createEventNormalizer(): (event: Record<string, unknown>) => AgentEvent | undefined {
  let assistantActivityId: string | undefined

  return (event) => {
    const timestamp = Date.now()
    if (event.type === "message_start" && isAssistantMessage(event.message)) {
      assistantActivityId = randomUUID()
      return { type: "message.started", eventId: randomUUID(), activityId: assistantActivityId, timestamp }
    }
    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const activityId = assistantActivityId ?? randomUUID()
      assistantActivityId = undefined
      return { type: "message.finished", eventId: randomUUID(), activityId, timestamp, text: assistantText(event.message) }
    }
    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent
      if (!assistantActivityId || typeof update.contentIndex !== "number") return undefined
      const activityId = `${assistantActivityId}:thinking:${update.contentIndex}`
      if (update.type === "thinking_start") return { type: "thinking.started", eventId: randomUUID(), activityId, timestamp }
      if (update.type === "thinking_end" && typeof update.content === "string") {
        return { type: "thinking.finished", eventId: randomUUID(), activityId, timestamp, content: update.content }
      }
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && "args" in event) {
      return { type: "tool.started", eventId: randomUUID(), activityId: event.toolCallId, timestamp, toolName: event.toolName, args: event.args }
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && typeof event.isError === "boolean") {
      return { type: "tool.finished", eventId: randomUUID(), activityId: event.toolCallId, timestamp, toolName: event.toolName, isError: event.isError }
    }
    return undefined
  }
}

function isAssistantMessage(value: unknown): value is { role: "assistant"; content?: unknown } {
  return isRecord(value) && value.role === "assistant"
}

function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((content): content is { type: "text"; text: string } => isRecord(content) && content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("")
}

function decodeRequest(frame: Buffer): WorkerRequest | undefined {
  try {
    const request = decode(frame)
    if (!isRecord(request) || request.version !== 1 || typeof request.requestId !== "string" || typeof request.agentId !== "string" || typeof request.runtimeGeneration !== "string") return undefined
    if (request.command === "status") return request as StatusRequest
    if (request.command === "send" && typeof request.message === "string" && typeof request.delivery === "string") return request as SendRequest
    if (request.command === "subscribe") return request as SubscribeRequest
    if (request.command === "unsubscribe" && typeof request.subscriptionId === "string") return request as UnsubscribeRequest
  } catch {}
  return undefined
}

function invalidResponse(request: WorkerRequest | undefined, agentId: string, generation: string): WorkerResponse {
  if (request?.command === "send") return sendResponse(request, agentId, generation, "Worker identity does not match the request")
  if (request?.command === "subscribe") return { version: 1, requestId: request.requestId, command: "subscribe", ok: false, agentId, runtimeGeneration: generation, error: "Worker identity does not match the request" }
  if (request?.command === "unsubscribe") return { version: 1, requestId: request.requestId, command: "unsubscribe", ok: false, agentId, runtimeGeneration: generation, subscriptionId: request.subscriptionId, error: "Worker identity does not match the request" }
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
