import { randomUUID } from "node:crypto"
import { Dealer } from "zeromq"
import { AgentUnavailableError } from "../types.js"
import { decode, encode, type SendRequest, type SendResponse, type StatusRequest, type StatusResponse } from "./protocol.js"
import type { AgentRecord } from "./registry.js"

const AGENT_STATES = new Set(["starting", "idle", "working", "stopped", "failed"])

export async function requestStatus(record: AgentRecord, timeoutMs = 1_000): Promise<NonNullable<StatusResponse["status"]>> {
  const request: StatusRequest = {
    version: 1,
    requestId: randomUUID(),
    command: "status",
    agentId: record.id,
    runtimeGeneration: record.runtime?.generation ?? "",
  }
  const response = await requestWorker(record, request, timeoutMs)

  if (
    !isStatusResponse(response) ||
    response.requestId !== request.requestId ||
    !response.ok ||
    !response.status ||
    response.status.id !== record.id ||
    response.status.name !== record.name ||
    response.status.runtimeGeneration !== record.runtime?.generation ||
    !AGENT_STATES.has(response.status.state)
  ) {
    throw new AgentUnavailableError(record.name)
  }
  return response.status
}

export async function requestSend(record: AgentRecord, message: string, delivery: "steer" | "followUp", timeoutMs = 10_000): Promise<{ acceptedAt: number }> {
  const request: SendRequest = {
    version: 1,
    requestId: randomUUID(),
    command: "send",
    agentId: record.id,
    runtimeGeneration: record.runtime?.generation ?? "",
    message,
    delivery,
  }
  const response = await requestWorker(record, request, timeoutMs)

  if (!isSendResponse(response) || response.requestId !== request.requestId || response.agentId !== record.id || response.runtimeGeneration !== record.runtime?.generation) {
    throw new AgentUnavailableError(record.name)
  }
  if (!response.ok) {
    if (typeof response.error === "string" && response.error) throw new Error(response.error)
    throw new AgentUnavailableError(record.name)
  }
  if (typeof response.acceptedAt !== "number") throw new AgentUnavailableError(record.name)
  return { acceptedAt: response.acceptedAt }
}

async function requestWorker(record: AgentRecord, request: StatusRequest | SendRequest, timeoutMs: number): Promise<unknown> {
  const runtime = record.runtime
  if (!runtime?.endpoint) throw new AgentUnavailableError(record.name)

  const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0, sendTimeout: timeoutMs })
  try {
    socket.connect(runtime.endpoint)
    await socket.send(encode(request))
    return decode((await withTimeout(socket.receive(), timeoutMs, record.name))[0])
  } catch (error) {
    if (error instanceof AgentUnavailableError) throw error
    throw new AgentUnavailableError(record.name)
  } finally {
    socket.close()
  }
}

function isStatusResponse(response: unknown): response is StatusResponse {
  return isRecord(response) && response.version === 1 && typeof response.requestId === "string"
}

function isSendResponse(response: unknown): response is SendResponse {
  return isRecord(response) && response.version === 1 && response.command === "send" && typeof response.requestId === "string" &&
    typeof response.agentId === "string" && typeof response.runtimeGeneration === "string" && typeof response.ok === "boolean"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new AgentUnavailableError(name)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
