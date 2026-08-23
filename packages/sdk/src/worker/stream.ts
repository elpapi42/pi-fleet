import { randomUUID } from "node:crypto"
import { Dealer } from "zeromq"
import { AgentUnavailableError, type AgentEvent, type JsonValue, type ToolOutput } from "../fleet/agent.js"
import {
  decode,
  encode,
  type EventFrame,
  type SubscribeRequest,
  type SubscribeResponse,
  type SubscriptionStatusRequest,
  type SubscriptionStatusResponse,
  type UnsubscribeRequest,
} from "./protocol.js"
import type { WorkerTarget } from "./control.js"

const STREAM_IDLE_PROBE_MS = 1_000

export type WorkerEventStream = AsyncIterable<AgentEvent> & AsyncIterator<AgentEvent> & {
  close(): Promise<void>
}

export function receiveEvents(record: WorkerTarget): WorkerEventStream {
  const controller = new AbortController()
  const iterator = readEvents(record, controller.signal)
  let closePromise: Promise<void> | undefined

  const close = (): Promise<void> => {
    if (!closePromise) {
      controller.abort()
      closePromise = iterator.return(undefined).then(() => undefined)
    }
    return closePromise
  }

  return {
    next: () => iterator.next(),
    async return(): Promise<IteratorResult<AgentEvent>> {
      await close()
      return { done: true, value: undefined }
    },
    async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
      controller.abort()
      try {
        return await iterator.throw(error)
      } finally {
        await close()
      }
    },
    [Symbol.asyncIterator]() {
      return this
    },
    close,
  }
}

async function* readEvents(record: WorkerTarget, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  if (signal.aborted) return
  const runtime = record.runtime
  if (!runtime?.endpoint) throw new AgentUnavailableError(record.name)

  const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0, sendTimeout: STREAM_IDLE_PROBE_MS })
  let subscriptionId: string | undefined
  try {
    socket.connect(runtime.endpoint)
    const request: SubscribeRequest = {
      version: 1,
      requestId: randomUUID(),
      command: "subscribe",
      agentId: record.id,
      runtimeGeneration: runtime.generation,
    }
    await socket.send(encode(request))
    const acknowledgement = await receiveWithDeadline(socket, signal)
    if (acknowledgement === "aborted") return
    if (acknowledgement === "idle") throw new AgentUnavailableError(record.name)
    const response = decode(acknowledgement[0])
    if (!isSubscribeResponse(response) || !response.ok || response.requestId !== request.requestId ||
      response.agentId !== record.id || response.runtimeGeneration !== runtime.generation ||
      typeof response.subscriptionId !== "string" || !response.subscriptionId) {
      throw new AgentUnavailableError(record.name)
    }
    subscriptionId = response.subscriptionId

    let nextFrame = socket.receive()
    void nextFrame.catch(() => {})
    let probeRequestId: string | undefined
    while (!signal.aborted) {
      const result = await awaitStreamFrame(nextFrame, signal)
      if (result === "aborted") return
      if (result === "idle") {
        if (probeRequestId) throw new AgentUnavailableError(record.name)
        probeRequestId = randomUUID()
        const probe: SubscriptionStatusRequest = {
          version: 1,
          requestId: probeRequestId,
          command: "subscription.status",
          agentId: record.id,
          runtimeGeneration: runtime.generation,
          subscriptionId,
        }
        await socket.send(encode(probe))
        continue
      }

      nextFrame = socket.receive()
      void nextFrame.catch(() => {})
      const frame = decode(result[0])
      if (isEventFrame(frame) && frame.agentId === record.id && frame.runtimeGeneration === runtime.generation &&
        frame.subscriptionId === subscriptionId) {
        yield frame.event
        continue
      }
      if (isSubscriptionStatusResponse(frame) && frame.requestId === probeRequestId &&
        frame.agentId === record.id && frame.runtimeGeneration === runtime.generation &&
        frame.subscriptionId === subscriptionId) {
        if (!frame.ok) throw new AgentUnavailableError(record.name)
        probeRequestId = undefined
        continue
      }
      throw new AgentUnavailableError(record.name)
    }
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof AgentUnavailableError) throw error
    throw new AgentUnavailableError(record.name)
  } finally {
    const unsubscribe: UnsubscribeRequest = {
      version: 1,
      requestId: randomUUID(),
      command: "unsubscribe",
      agentId: record.id,
      runtimeGeneration: runtime.generation,
      subscriptionId,
    }
    try {
      await socket.send(encode(unsubscribe))
    } catch {
      // A closed or failed worker cannot retain this connection-scoped subscription.
    }
    socket.close()
  }
}

async function receiveWithDeadline(socket: Dealer, signal: AbortSignal): Promise<Buffer[] | "idle" | "aborted"> {
  const receive = socket.receive()
  void receive.catch(() => {})
  return awaitStreamFrame(receive, signal)
}

async function awaitStreamFrame(nextFrame: Promise<Buffer[]>, signal: AbortSignal): Promise<Buffer[] | "idle" | "aborted"> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      nextFrame,
      new Promise<"idle">((resolve) => {
        timer = setTimeout(() => resolve("idle"), STREAM_IDLE_PROBE_MS)
      }),
      new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted")
        signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function isSubscribeResponse(response: unknown): response is SubscribeResponse {
  return isRecord(response) && response.version === 1 && response.command === "subscribe" &&
    typeof response.requestId === "string" && typeof response.agentId === "string" &&
    typeof response.runtimeGeneration === "string" && typeof response.ok === "boolean"
}

function isSubscriptionStatusResponse(response: unknown): response is SubscriptionStatusResponse {
  return isRecord(response) && response.version === 1 && response.command === "subscription.status" &&
    typeof response.requestId === "string" && typeof response.agentId === "string" &&
    typeof response.runtimeGeneration === "string" && typeof response.subscriptionId === "string" &&
    typeof response.ok === "boolean"
}

function isEventFrame(response: unknown): response is EventFrame {
  if (!isRecord(response) || response.version !== 1 || response.command !== "event" ||
    typeof response.agentId !== "string" || typeof response.runtimeGeneration !== "string" ||
    typeof response.subscriptionId !== "string") return false
  return isAgentEvent(response.event)
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.eventId !== "string" ||
    typeof value.activityId !== "string" || typeof value.timestamp !== "number") return false
  switch (value.type) {
    case "thinking.started":
    case "message.started":
      return true
    case "thinking.finished":
      return typeof value.content === "string"
    case "message.finished":
      return typeof value.text === "string"
    case "tool.started":
      return typeof value.toolName === "string" && typeof value.argsTruncated === "boolean" && isJsonValue(value.args)
    case "tool.finished":
      return typeof value.toolName === "string" && typeof value.isError === "boolean" && isToolOutput(value.output)
    default:
      return false
  }
}

function isToolOutput(value: unknown): value is ToolOutput {
  if (!isRecord(value) || !Array.isArray(value.content) || typeof value.truncated !== "boolean" || typeof value.detailsTruncated !== "boolean") return false
  if ("details" in value && !isJsonValue(value.details)) return false
  return value.content.every((part) => isRecord(part) && (
    part.type === "text" && typeof part.text === "string" ||
    part.type === "image" && typeof part.mimeType === "string" && typeof part.byteLength === "number" && part.omitted === true
  ))
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
