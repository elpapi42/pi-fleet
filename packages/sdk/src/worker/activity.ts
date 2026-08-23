import { randomUUID } from "node:crypto"
import type { AgentEvent } from "../fleet/agent.js"
import type { EventFrame } from "./protocol.js"

type Subscriber = {
  route: Buffer
  subscriptionId: string
  events: EventFrame[]
}

export type ActivityOutbound = {
  route: Buffer
  message: EventFrame
  subscriptionId: string
}

const SUBSCRIBER_QUEUE_LIMIT = 128

export class LiveActivity {
  readonly #agentId: string
  readonly #runtimeGeneration: string
  readonly #subscribers = new Map<string, Subscriber>()
  readonly #normalize = createEventNormalizer()
  #lastSubscriptionId: string | undefined

  constructor(agentId: string, runtimeGeneration: string) {
    this.#agentId = agentId
    this.#runtimeGeneration = runtimeGeneration
  }

  subscribe(route: Buffer): string {
    const subscriptionId = randomUUID()
    this.#subscribers.set(subscriptionId, { route: Buffer.from(route), subscriptionId, events: [] })
    return subscriptionId
  }

  unsubscribe(route: Buffer, subscriptionId?: string): void {
    if (subscriptionId) {
      const subscriber = this.#subscribers.get(subscriptionId)
      if (subscriber?.route.equals(route)) this.#subscribers.delete(subscriptionId)
      return
    }
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.route.equals(route)) this.#subscribers.delete(subscriber.subscriptionId)
    }
  }

  hasSubscription(route: Buffer, subscriptionId: string): boolean {
    return this.#subscribers.get(subscriptionId)?.route.equals(route) ?? false
  }

  publishPiEvent(rawEvent: Record<string, unknown>): boolean {
    const event = this.#normalize(rawEvent)
    if (!event) return false

    let queued = false
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.events.length >= SUBSCRIBER_QUEUE_LIMIT) {
        this.#subscribers.delete(subscriber.subscriptionId)
        continue
      }
      subscriber.events.push({
        version: 1,
        command: "event",
        agentId: this.#agentId,
        runtimeGeneration: this.#runtimeGeneration,
        subscriptionId: subscriber.subscriptionId,
        event,
      })
      queued = true
    }
    return queued
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
  }

  close(): void {
    this.#subscribers.clear()
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
