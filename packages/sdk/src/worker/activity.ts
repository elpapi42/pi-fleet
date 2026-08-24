import { randomUUID } from "node:crypto"
import type { AgentEvent, JsonValue, ToolOutput, UnsequencedAgentEvent } from "../fleet/agent.js"
import type { EventFrame, StreamEndFrame } from "./protocol.js"

type Subscriber = {
  route: Buffer
  subscriptionId: string
  events: Array<EventFrame | StreamEndFrame>
  pendingLive: Array<EventFrame | StreamEndFrame>
  replaying: boolean
}

export type ActivityOutbound = {
  route: Buffer
  message: EventFrame | StreamEndFrame
  subscriptionId: string
}

const SUBSCRIBER_QUEUE_LIMIT = 128
const MAX_ARGS_BYTES = 16 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_DETAILS_BYTES = 16 * 1024
const MAX_CONTENT_PARTS = 64
const MAX_IMAGE_MIME_TYPE_BYTES = 256
const MAX_TOOL_IDENTITY_BYTES = 256

export class LiveActivity {
  readonly #agentId: string
  readonly #runtimeGeneration: string
  readonly #subscribers = new Map<string, Subscriber>()
  readonly #replayWaiters: Array<() => void> = []
  #normalize = createEventNormalizer()
  #lastSubscriptionId: string | undefined

  constructor(agentId: string, runtimeGeneration: string) {
    this.#agentId = agentId
    this.#runtimeGeneration = runtimeGeneration
  }

  normalizePiEvent(rawEvent: Record<string, unknown>): UnsequencedAgentEvent[] {
    return this.#normalize(rawEvent)
  }

  resetPiActivity(): void {
    this.#normalize = createEventNormalizer()
  }

  subscribe(route: Buffer, replaying: boolean): string {
    const subscriptionId = randomUUID()
    this.#subscribers.set(subscriptionId, {
      route: Buffer.from(route),
      subscriptionId,
      events: [],
      pendingLive: [],
      replaying,
    })
    return subscriptionId
  }

  queueReplay(subscriptionId: string, entry: { sequence: number; event: AgentEvent }): boolean {
    const subscriber = this.#subscribers.get(subscriptionId)
    if (!subscriber || !subscriber.replaying) return false
    return this.enqueue(subscriber, this.frame(subscriptionId, entry.sequence, entry.event), false)
  }

  finishReplay(subscriptionId: string): boolean {
    const subscriber = this.#subscribers.get(subscriptionId)
    if (!subscriber || !subscriber.replaying) return false
    subscriber.replaying = false
    subscriber.events.push(...subscriber.pendingLive)
    subscriber.pendingLive = []
    this.resolveReplayWaiters()
    return true
  }

  waitForReplays(): Promise<void> {
    if (![...this.#subscribers.values()].some(({ replaying }) => replaying)) return Promise.resolve()
    return new Promise((resolve) => this.#replayWaiters.push(resolve))
  }

  publishEvent(sequence: number, event: AgentEvent): boolean {
    let queued = false
    for (const subscriber of [...this.#subscribers.values()]) {
      queued = this.enqueue(subscriber, this.frame(subscriber.subscriptionId, sequence, event), subscriber.replaying) || queued
    }
    return queued
  }

  endSubscriptions(): boolean {
    let queued = false
    for (const subscriber of [...this.#subscribers.values()]) {
      queued = this.enqueue(subscriber, this.endFrame(subscriber.subscriptionId), subscriber.replaying) || queued
    }
    return queued
  }

  unsubscribe(route: Buffer, subscriptionId?: string): void {
    if (subscriptionId) {
      const subscriber = this.#subscribers.get(subscriptionId)
      if (subscriber?.route.equals(route)) this.#subscribers.delete(subscriptionId)
      this.resolveReplayWaiters()
      return
    }
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.route.equals(route)) this.#subscribers.delete(subscriber.subscriptionId)
    }
    this.resolveReplayWaiters()
  }

  hasSubscription(route: Buffer, subscriptionId: string): boolean {
    return this.#subscribers.get(subscriptionId)?.route.equals(route) ?? false
  }

  nextOutbound(): ActivityOutbound | undefined {
    const subscribers = [...this.#subscribers.values()]
    if (subscribers.length === 0) return undefined

    const previousIndex = this.#lastSubscriptionId
      ? subscribers.findIndex(({ subscriptionId }) => subscriptionId === this.#lastSubscriptionId)
      : -1
    for (let offset = 1; offset <= subscribers.length; offset += 1) {
      const subscriber = subscribers[(previousIndex + offset) % subscribers.length]
      const message = subscriber.events.shift()
      if (!message) continue
      this.#lastSubscriptionId = subscriber.subscriptionId
      return { route: subscriber.route, message, subscriptionId: subscriber.subscriptionId }
    }
    return undefined
  }

  deliveryFailed(subscriptionId: string): void {
    this.#subscribers.delete(subscriptionId)
    this.resolveReplayWaiters()
  }

  close(): void {
    this.#subscribers.clear()
    this.resolveReplayWaiters()
  }

  private enqueue(subscriber: Subscriber, frame: EventFrame | StreamEndFrame, pending: boolean): boolean {
    if (subscriber.events.length + subscriber.pendingLive.length >= SUBSCRIBER_QUEUE_LIMIT) {
      this.#subscribers.delete(subscriber.subscriptionId)
      this.resolveReplayWaiters()
      return false
    }
    if (pending) subscriber.pendingLive.push(frame)
    else subscriber.events.push(frame)
    return true
  }

  private frame(subscriptionId: string, sequence: number, event: AgentEvent): EventFrame {
    return {
      version: 1,
      command: "event",
      agentId: this.#agentId,
      runtimeGeneration: this.#runtimeGeneration,
      subscriptionId,
      sequence,
      event,
    }
  }

  private resolveReplayWaiters(): void {
    if ([...this.#subscribers.values()].some(({ replaying }) => replaying)) return
    for (const resolve of this.#replayWaiters.splice(0)) resolve()
  }

  private endFrame(subscriptionId: string): StreamEndFrame {
    return {
      version: 1,
      command: "stream.end",
      agentId: this.#agentId,
      runtimeGeneration: this.#runtimeGeneration,
      subscriptionId,
    }
  }
}

function createEventNormalizer(): (event: Record<string, unknown>) => UnsequencedAgentEvent[] {
  let assistantEnvelope: { id: string; messageActivityId?: string } | undefined

  const currentEnvelope = () => assistantEnvelope ??= { id: randomUUID() }
  const startMessage = (envelope: { id: string; messageActivityId?: string }, timestamp: number): UnsequencedAgentEvent => {
    envelope.messageActivityId ??= randomUUID()
    return { type: "message.started", eventId: randomUUID(), activityId: envelope.messageActivityId, timestamp }
  }

  return (event) => {
    const timestamp = Date.now()
    if (event.type === "message_start" && isAssistantMessage(event.message)) {
      assistantEnvelope = { id: randomUUID() }
      return []
    }
    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const text = assistantText(event.message)
      const envelope = currentEnvelope()
      if (!hasVisibleText(text)) {
        assistantEnvelope = undefined
        return []
      }
      const started = envelope.messageActivityId ? [] : [startMessage(envelope, timestamp)]
      const finished: UnsequencedAgentEvent = {
        type: "message.finished",
        eventId: randomUUID(),
        activityId: envelope.messageActivityId!,
        timestamp,
        text,
      }
      assistantEnvelope = undefined
      return [...started, finished]
    }
    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent
      if (typeof update.contentIndex !== "number") return []
      const envelope = currentEnvelope()
      const thinkingActivityId = `${envelope.id}:thinking:${update.contentIndex}`
      if (update.type === "thinking_start") {
        return [{ type: "thinking.started", eventId: randomUUID(), activityId: thinkingActivityId, timestamp }]
      }
      if (update.type === "thinking_end" && typeof update.content === "string") {
        return [{ type: "thinking.finished", eventId: randomUUID(), activityId: thinkingActivityId, timestamp, content: update.content }]
      }
      if (hasVisibleTextUpdate(update, event.message)) return envelope.messageActivityId ? [] : [startMessage(envelope, timestamp)]
      return []
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && "args" in event) {
      const { value: args, truncated: argsTruncated } = boundedJson(event.args, MAX_ARGS_BYTES)
      return [{
        type: "tool.started",
        eventId: randomUUID(),
        activityId: truncateJsonString(event.toolCallId, MAX_TOOL_IDENTITY_BYTES).value,
        timestamp,
        toolName: truncateJsonString(event.toolName, MAX_TOOL_IDENTITY_BYTES).value,
        args: args ?? null,
        argsTruncated,
      }]
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string" && typeof event.isError === "boolean") {
      return [{
        type: "tool.finished",
        eventId: randomUUID(),
        activityId: truncateJsonString(event.toolCallId, MAX_TOOL_IDENTITY_BYTES).value,
        timestamp,
        toolName: truncateJsonString(event.toolName, MAX_TOOL_IDENTITY_BYTES).value,
        isError: event.isError,
        output: normalizeToolOutput(event.result),
      }]
    }
    return []
  }
}

function normalizeToolOutput(result: unknown): ToolOutput {
  const rawContent = isRecord(result) && Array.isArray(result.content) ? result.content : []
  const content: ToolOutput["content"] = []
  let remainingTextBytes = MAX_TEXT_BYTES
  let truncated = !isRecord(result) || !Array.isArray(result.content)

  for (const item of rawContent) {
    if (content.length >= MAX_CONTENT_PARTS) {
      truncated = true
      break
    }
    if (!isRecord(item)) {
      truncated = true
      continue
    }
    if (item.type === "text" && typeof item.text === "string") {
      const text = truncateJsonString(item.text, remainingTextBytes)
      content.push({ type: "text", text: text.value })
      remainingTextBytes -= jsonStringByteLength(text.value)
      if (text.truncated) truncated = true
      continue
    }
    if (item.type === "image" && typeof item.mimeType === "string" && typeof item.data === "string") {
      const mimeType = truncateJsonString(item.mimeType, MAX_IMAGE_MIME_TYPE_BYTES)
      content.push({ type: "image", mimeType: mimeType.value, byteLength: Buffer.byteLength(item.data, "base64"), omitted: true })
      truncated = true
      continue
    }
    truncated = true
  }

  const { value: details, truncated: detailsTruncated } = isRecord(result) && "details" in result
    ? boundedJson(result.details, MAX_DETAILS_BYTES)
    : { value: undefined, truncated: false }
  return { content, ...(details === undefined ? {} : { details }), detailsTruncated, truncated: truncated || detailsTruncated }
}

function boundedJson(value: unknown, maxBytes: number): { value?: JsonValue; truncated: boolean } {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) return { truncated: true }
    return { value: JSON.parse(serialized) as JsonValue, truncated: false }
  } catch {
    return { truncated: true }
  }
}

function truncateJsonString(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (jsonStringByteLength(value) <= maxBytes) return { value, truncated: false }
  let bytes = 2
  const characters: string[] = []
  for (const character of value) {
    const characterBytes = jsonStringByteLength(character) - 2
    if (bytes + characterBytes > maxBytes) return { value: characters.join(""), truncated: true }
    characters.push(character)
    bytes += characterBytes
  }
  return { value: characters.join(""), truncated: true }
}

function jsonStringByteLength(value: string): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function isAssistantMessage(value: unknown): value is { role: "assistant"; content?: unknown } {
  return isRecord(value) && value.role === "assistant"
}

function hasVisibleTextUpdate(update: Record<string, unknown>, message: unknown): boolean {
  return (update.type === "text_start" && isAssistantMessage(message) && hasVisibleText(assistantText(message))) ||
    (update.type === "text_delta" && typeof update.delta === "string" && hasVisibleText(update.delta)) ||
    (update.type === "text_end" && typeof update.content === "string" && hasVisibleText(update.content))
}

function hasVisibleText(text: string): boolean {
  return /\S/.test(text)
}

function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((content): content is { type: "text"; text: string } => isRecord(content) && content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
