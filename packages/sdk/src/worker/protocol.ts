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
}

export type SubscribeRequest = {
  version: 1
  requestId: string
  command: "subscribe"
  agentId: string
  runtimeGeneration: string
}

export type UnsubscribeRequest = {
  version: 1
  requestId: string
  command: "unsubscribe"
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
}

export type SubscribeResponse = {
  version: 1
  requestId: string
  command: "subscribe"
  ok: boolean
  agentId: string
  runtimeGeneration: string
  subscriptionId?: string
  error?: string
}

export type UnsubscribeResponse = {
  version: 1
  requestId: string
  command: "unsubscribe"
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
  event: AgentEvent
}

export type WorkerMessage =
  | StatusRequest
  | SendRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | StatusResponse
  | SendResponse
  | SubscribeResponse
  | UnsubscribeResponse
  | EventFrame

export function encode(message: WorkerMessage): string {
  return JSON.stringify(message)
}

export function decode(text: Buffer): unknown {
  return JSON.parse(text.toString("utf8"))
}
