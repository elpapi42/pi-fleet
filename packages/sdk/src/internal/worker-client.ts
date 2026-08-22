import { Dealer } from "zeromq"
import { randomUUID } from "node:crypto"
import { AgentUnavailableError } from "../types.js"
import { decode, encode, type StatusRequest, type StatusResponse } from "./protocol.js"
import type { AgentRecord } from "./registry.js"

const AGENT_STATES = new Set(["starting", "idle", "working", "stopped", "failed"])

export async function requestStatus(record: AgentRecord, timeoutMs = 1_000): Promise<NonNullable<StatusResponse["status"]>> {
  const runtime = record.runtime
  if (!runtime?.endpoint) throw new AgentUnavailableError(record.name)

  const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0, sendTimeout: timeoutMs })
  try {
    socket.connect(runtime.endpoint)
    const request: StatusRequest = {
      version: 1,
      requestId: randomUUID(),
      command: "status",
      agentId: record.id,
      runtimeGeneration: runtime.generation,
    }
    await socket.send(encode(request))
    const frames = await withTimeout(socket.receive(), timeoutMs, record.name)
    const response = decode(frames[0]) as StatusResponse
    if (
      !response ||
      response.version !== 1 ||
      response.requestId !== request.requestId ||
      !response.ok ||
      !response.status ||
      response.status.id !== record.id ||
      response.status.name !== record.name ||
      response.status.runtimeGeneration !== runtime.generation ||
      !AGENT_STATES.has(response.status.state)
    ) {
      throw new AgentUnavailableError(record.name)
    }
    return response.status
  } catch (error) {
    if (error instanceof AgentUnavailableError) throw error
    throw new AgentUnavailableError(record.name)
  } finally {
    socket.close()
  }
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
