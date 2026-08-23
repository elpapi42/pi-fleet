import type { AgentEvent, AgentState } from "../fleet/agent.js"

export type StatusRequest = {
  version: 1
  requestId: string
  command: "status"
  agentId: string
  runtimeGeneration: string
}

export type SendRequest = {
  version: 1
  requestId: string
  command: "send"
  agentId: string
  runtimeGeneration: string
  message: string
  delivery: "steer" | "followUp"
  deadlineAt: number
}

export type SubscribeRequest = {
  version: 1
  requestId: string
  command: "subscribe"
  agentId: string
  runtimeGeneration: string
  fromStart?: true
  after?: string
}

export type UnsubscribeRequest = {
  version: 1
  requestId: string
  command: "unsubscribe"
  agentId: string
  runtimeGeneration: string
  subscriptionId?: string
}

export type SubscriptionStatusRequest = {
  version: 1
  requestId: string
  command: "subscription.status"
  agentId: string
  runtimeGeneration: string
  subscriptionId: string
}

export type StatusResponse = {
  version: 1
  requestId: string
  ok: boolean
  status?: { id: string; name: string; runtimeGeneration: string; state: AgentState }
  error?: string
}

export type SendResponse = {
  version: 1
  requestId: string
  command: "send"
  ok: boolean
  agentId: string
  runtimeGeneration: string
  acceptedAt?: number
  error?: string
  errorCode?: "recovery-queue-full" | "send-uncertain" | "send-expired" | "unavailable"
}

export type SubscribeResponse = {
  version: 1
  requestId: string
  command: "subscribe"
  ok: boolean
  agentId: string
  runtimeGeneration: string
  subscriptionId?: string
  afterSequence?: number
  resumeCursor?: string
  error?: string
  errorCode?: "invalid-cursor"
}

export type UnsubscribeResponse = {
  version: 1
  requestId: string
  command: "unsubscribe"
  ok: boolean
  agentId: string
  runtimeGeneration: string
  subscriptionId?: string
  error?: string
}

export type SubscriptionStatusResponse = {
  version: 1
  requestId: string
  command: "subscription.status"
  ok: boolean
  agentId: string
  runtimeGeneration: string
  subscriptionId: string
  error?: string
}

export type EventFrame = {
  version: 1
  command: "event"
  agentId: string
  runtimeGeneration: string
  subscriptionId: string
  sequence: number
  event: AgentEvent
}

export type WorkerMessage =
  | StatusRequest
  | SendRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | SubscriptionStatusRequest
  | StatusResponse
  | SendResponse
  | SubscribeResponse
  | UnsubscribeResponse
  | SubscriptionStatusResponse
  | EventFrame

export function encode(message: WorkerMessage): string {
  return JSON.stringify(message)
}

export function decode(text: Buffer): unknown {
  return JSON.parse(text.toString("utf8"))
}
