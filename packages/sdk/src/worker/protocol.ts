import type { AgentState } from "../fleet/agent.js"

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

export function encode(message: StatusRequest | SendRequest | StatusResponse | SendResponse): string {
  return JSON.stringify(message)
}

export function decode(text: Buffer): unknown {
  return JSON.parse(text.toString("utf8"))
}
