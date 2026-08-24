import { createHash, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { Dealer } from "zeromq"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { AgentRecoveryQueueFullError, AgentSendUncertainError, AgentUnavailableError } from "../fleet/agent.js"
import { decode, encode, type DestroyRequest, type DestroyResponse, type SendRequest, type SendResponse, type StatusRequest, type StatusResponse } from "./protocol.js"

export type WorkerTarget = {
  id: string
  name: string
  runtime?: {
    generation: string
    endpoint?: string
  }
}

const AGENT_STATES = new Set(["starting", "idle", "working", "stopped", "failed"])

export function workerEndpoint(stateDir: string, agentId: string, generation: string): string {
  const identity = createHash("sha256").update(`${stateDir}\0${agentId}\0${generation}`).digest("hex").slice(0, 24)
  return `ipc://${join(stateDir, "ipc", `${identity}.sock`)}`
}

export function launchWorker(stateDir: string, agentId: string, generation: string, claimId?: string): ChildProcess {
  const serverPath = fileURLToPath(new URL("./server.js", import.meta.url))
  const child = spawn(process.execPath, [serverPath, "--state-dir", stateDir, "--agent", agentId, "--generation", generation, ...(claimId ? ["--claim", claimId] : [])], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()
  return child
}

export async function waitForWorkerProcessGroupExit(workerPid: number | undefined, timeoutMs = 5_000): Promise<boolean> {
  if (!workerPid || process.platform === "win32") return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-workerPid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch (error) {
      if (isMissingProcess(error)) return true
      return false
    }
  }
  return false
}

export async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  worker.kill("SIGTERM")
  if (await waitForExit(worker, 1_000)) return
  worker.kill("SIGKILL")
  await waitForExit(worker, 1_000)
}

export async function requestStatus(record: WorkerTarget, timeoutMs = 1_000): Promise<NonNullable<StatusResponse["status"]>> {
  const request: StatusRequest = {
    version: 1,
    requestId: randomUUID(),
    command: "status",
    agentId: record.id,
    runtimeGeneration: record.runtime?.generation ?? "",
  }
  const response = await requestWorker(record, request, timeoutMs)

  if (!isStatusResponse(response) || response.requestId !== request.requestId || !response.ok || !response.status ||
    response.status.id !== record.id || response.status.name !== record.name ||
    response.status.runtimeGeneration !== record.runtime?.generation || !AGENT_STATES.has(response.status.state)) {
    throw new AgentUnavailableError(record.name)
  }
  return response.status
}

export async function requestDestroy(record: WorkerTarget, timeoutMs = 60_000): Promise<void> {
  const request: DestroyRequest = {
    version: 1,
    requestId: randomUUID(),
    command: "destroy",
    agentId: record.id,
    runtimeGeneration: record.runtime?.generation ?? "",
  }
  let response: unknown
  try {
    response = await requestWorker(record, request, timeoutMs)
  } catch {
    throw new AgentUnavailableError(record.name)
  }
  if (!isDestroyResponse(response) || response.requestId !== request.requestId || !response.ok ||
    response.agentId !== record.id || response.runtimeGeneration !== record.runtime?.generation) {
    throw new AgentUnavailableError(record.name)
  }
}

export async function requestSend(record: WorkerTarget, message: string, delivery: "steer" | "followUp", timeoutMs = 60_000, deadlineAt = Date.now() + 60_000): Promise<{ acceptedAt: number }> {
  const request: SendRequest = {
    version: 1,
    requestId: randomUUID(),
    command: "send",
    agentId: record.id,
    runtimeGeneration: record.runtime?.generation ?? "",
    message,
    delivery,
    deadlineAt,
  }
  let response: unknown
  try {
    response = await requestWorker(record, request, timeoutMs)
  } catch (error) {
    if (error instanceof WorkerRequestFailure) {
      if (error.accepted) throw new AgentSendUncertainError(record.name)
      throw new AgentUnavailableError(record.name)
    }
    throw error
  }

  if (!isSendResponse(response) || response.requestId !== request.requestId || response.agentId !== record.id || response.runtimeGeneration !== record.runtime?.generation) {
    throw new AgentSendUncertainError(record.name)
  }
  if (!response.ok) {
    if (response.errorCode === "recovery-queue-full") throw new AgentRecoveryQueueFullError(record.name)
    if (response.errorCode === "send-uncertain") throw new AgentSendUncertainError(record.name)
    if (response.errorCode === "unavailable") throw new AgentUnavailableError(record.name)
    if (typeof response.error === "string" && response.error) throw new Error(response.error)
    throw new AgentUnavailableError(record.name)
  }
  if (typeof response.acceptedAt !== "number") throw new AgentUnavailableError(record.name)
  return { acceptedAt: response.acceptedAt }
}

class WorkerRequestFailure extends Error {
  readonly accepted: boolean

  constructor(accepted: boolean) {
    super("Worker request failed")
    this.accepted = accepted
  }
}

async function requestWorker(record: WorkerTarget, request: StatusRequest | SendRequest | DestroyRequest, timeoutMs: number): Promise<unknown> {
  const runtime = record.runtime
  if (!runtime?.endpoint) throw new AgentUnavailableError(record.name)

  const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0, sendTimeout: timeoutMs })
  let accepted = false
  try {
    socket.connect(runtime.endpoint)
    await socket.send(encode(request))
    accepted = true
    return decode((await withTimeout(socket.receive(), timeoutMs, record.name))[0])
  } catch (error) {
    if (request.command === "status" || request.command === "destroy" || (error instanceof AgentUnavailableError && !accepted)) throw new AgentUnavailableError(record.name)
    throw new WorkerRequestFailure(accepted)
  } finally {
    socket.close()
  }
}

function isStatusResponse(response: unknown): response is StatusResponse {
  return isRecord(response) && response.version === 1 && typeof response.requestId === "string"
}

function isDestroyResponse(response: unknown): response is DestroyResponse {
  return isRecord(response) && response.version === 1 && response.command === "destroy" &&
    typeof response.requestId === "string" && typeof response.agentId === "string" &&
    typeof response.runtimeGeneration === "string" && typeof response.ok === "boolean"
}

function isSendResponse(response: unknown): response is SendResponse {
  return isRecord(response) && response.version === 1 && response.command === "send" && typeof response.requestId === "string" &&
    typeof response.agentId === "string" && typeof response.runtimeGeneration === "string" && typeof response.ok === "boolean" &&
    (response.errorCode === undefined || response.errorCode === "recovery-queue-full" || response.errorCode === "send-uncertain" || response.errorCode === "send-expired" || response.errorCode === "unavailable")
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

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH"
}

async function waitForExit(worker: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (worker.exitCode !== null || worker.signalCode !== null) return true
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    worker.once("exit", onExit)
  })
}
