import type { AgentState } from "../types.js"

export type StatusRequest = {
  version: 1
  requestId: string
  command: "status"
  agentId: string
  runtimeGeneration: string
}

export type StatusResponse = {
  version: 1
  requestId: string
  ok: boolean
  status?: { id: string; name: string; runtimeGeneration: string; state: AgentState }
  error?: string
}

export function encode(message: StatusRequest | StatusResponse): string {
  return JSON.stringify(message)
}

export function decode(text: Buffer): unknown {
  return JSON.parse(text.toString("utf8"))
}
