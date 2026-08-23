import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { capability } from "zeromq"
import {
  AgentHandle,
  AgentNameTakenError,
  AgentNotFoundError,
  AgentUnavailableError,
  type Agent,
  type AgentEvent,
  type AgentStatus,
  type AgentSummary,
  type ReceiveOptions,
  type SendDelivery,
  type SendOptions,
  type SendResult,
} from "./agent.js"
import { openStore, type AgentRecord, type FleetStore } from "../state/store.js"
import { launchWorker, requestSend, requestStatus, stopWorker, waitForWorkerProcessGroupExit, workerEndpoint, type WorkerTarget } from "../worker/control.js"
import { receiveEvents, type WorkerEventStream } from "../worker/stream.js"
import { validatePiArguments } from "../pi/runtime.js"

const STARTUP_TIMEOUT_MS = 10_000
const RECOVERY_TIMEOUT_MS = 45_000
const OPERATION_TIMEOUT_MS = 60_000

export type ConnectOptions = {
  /** A private state directory. Intended for isolated tests and advanced local setups. */
  stateDir?: string
}

export type CreateAgentOptions = {
  name: string
  cwd: string
  piArgs?: string[]
}

export interface PiFleetClient {
  create(options: CreateAgentOptions): Promise<Agent>
  get(name: string): Promise<Agent>
  list(): Promise<AgentSummary[]>
  close(): Promise<void>
}

class PiFleetClientImpl implements PiFleetClient {
  readonly #store: FleetStore
  readonly #stateDir: string
  readonly #streams = new Set<WorkerEventStream>()
  #closed = false
  readonly #recoveries = new Map<string, Promise<WorkerTarget>>()

  constructor(store: FleetStore, stateDir: string) {
    this.#store = store
    this.#stateDir = stateDir
  }

  async create(options: CreateAgentOptions): Promise<Agent> {
    this.assertOpen()
    const input = await validateCreateOptions(options)
    const id = randomUUID()
    const generation = randomUUID()
    const claimId = randomUUID()
    const now = Date.now()
    const record: AgentRecord = {
      id,
      name: input.name,
      cwd: input.cwd,
      piArgs: input.piArgs,
      state: "starting",
      runtime: {
        generation,
        state: "starting",
        endpoint: workerEndpoint(this.#stateDir, id, generation),
        claimId,
        claimedAt: now,
      },
      lastEventSeq: 0,
      createdAt: now,
      updatedAt: now,
    }

    if (!(await this.#store.create(record))) throw new AgentNameTakenError(input.name)

    let worker: ChildProcess | undefined
    try {
      worker = launchWorker(this.#stateDir, id, generation, claimId)
      await waitForWorkerReady(workerTarget(record), worker, STARTUP_TIMEOUT_MS)
      return new AgentHandle(this, id, input.name)
    } catch (error) {
      await stopWorker(worker)
      await this.#store.rollbackCreation(id, input.name, generation)
      throw error
    }
  }

  async get(name: string): Promise<Agent> {
    this.assertOpen()
    const record = this.#store.getByName(name)
    if (!record) throw new AgentNotFoundError(name)
    return new AgentHandle(this, record.id, record.name)
  }

  async list(): Promise<AgentSummary[]> {
    this.assertOpen()
    return this.#store.list().map(({ id, name, cwd, state }) => ({ id, name, cwd, state }))
  }

  async status(id: string, name: string): Promise<AgentStatus> {
    this.assertOpen()
    const record = this.#store.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    const deadlineAt = Date.now() + OPERATION_TIMEOUT_MS
    let status
    try {
      status = await requestStatus(workerTarget(record))
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error
      const recovered = await this.reconcileWorker(record.id, record.name, deadlineAt)
      status = await requestStatus(recovered, Math.max(1, Math.min(1_000, deadlineAt - Date.now())))
    }
    return { id: status.id, name: status.name, state: status.state }
  }

  async send(id: string, name: string, message: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertOpen()
    const record = this.#store.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    if (typeof message !== "string" || !message.trim()) throw new TypeError("Message must not be empty")
    const delivery = options.delivery ?? "steer"
    if (!isSendDelivery(delivery)) throw new TypeError(`Invalid delivery: ${String(delivery)}`)
    const deadlineAt = Date.now() + OPERATION_TIMEOUT_MS
    const target = await this.resolveWorker(record, deadlineAt)
    try {
      return await requestSend(target, message, delivery, Math.max(1, deadlineAt - Date.now()), deadlineAt)
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error
      const recovered = await this.reconcileWorker(record.id, record.name, deadlineAt)
      return requestSend(recovered, message, delivery, Math.max(1, deadlineAt - Date.now()), deadlineAt)
    }
  }

  receive(id: string, name: string, options: ReceiveOptions = {}): AsyncIterable<AgentEvent> {
    this.assertOpen()
    const record = this.#store.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    const receiveOptions = normalizeReceiveOptions(options)
    const stream = receiveEvents(workerTarget(record), receiveOptions)
    this.#streams.add(stream)
    return trackStream(stream, this.#streams)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await Promise.all([...this.#streams].map((stream) => stream.close()))
    this.#streams.clear()
    await this.#store.close()
  }

  private async resolveWorker(record: AgentRecord, deadlineAt: number): Promise<WorkerTarget> {
    const target = workerTarget(record)
    try {
      await requestStatus(target, Math.min(500, Math.max(1, deadlineAt - Date.now())))
      return target
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error
      return this.reconcileWorker(record.id, record.name, deadlineAt)
    }
  }

  private reconcileWorker(id: string, name: string, deadlineAt: number): Promise<WorkerTarget> {
    const current = this.#recoveries.get(id)
    if (current) return current
    const recovery = this.recoverWorker(id, name, deadlineAt).finally(() => this.#recoveries.delete(id))
    this.#recoveries.set(id, recovery)
    return recovery
  }

  private async recoverWorker(id: string, name: string, deadlineAt: number): Promise<WorkerTarget> {
    const recoveryDeadline = Math.min(deadlineAt, Date.now() + RECOVERY_TIMEOUT_MS)
    while (Date.now() < recoveryDeadline) {
      const record = this.#store.getById(id)
      if (!record || record.name !== name) throw new AgentNotFoundError(name)
      const runtime = record.runtime
      if (!runtime?.endpoint) throw new AgentUnavailableError(name)
      try {
        await requestStatus(workerTarget(record), Math.min(500, recoveryDeadline - Date.now()))
        return workerTarget(record)
      } catch (error) {
        if (!(error instanceof AgentUnavailableError)) throw error
      }

      const generation = randomUUID()
      const claimId = randomUUID()
      const claimedAt = Date.now()
      const claim = await this.#store.claimRuntime(id, runtime.generation, {
        generation,
        claimId,
        claimedAt,
        endpoint: workerEndpoint(this.#stateDir, id, generation),
        workerPid: runtime.workerPid,
      }, (cursor) => ({ type: "work.interrupted" as const, cursor, eventId: randomUUID(), activityId: randomUUID(), timestamp: Date.now() }))
      if (!claim) {
        await wait(100)
        continue
      }

      let worker: ChildProcess | undefined
      try {
        if (!(await waitForWorkerProcessGroupExit(claim.record.runtime?.workerPid, Math.min(5_000, recoveryDeadline - Date.now())))) {
          throw new AgentUnavailableError(name)
        }
        worker = launchWorker(this.#stateDir, id, generation, claimId)
        await waitForWorkerReady(workerTarget(claim.record), worker, Math.min(STARTUP_TIMEOUT_MS, recoveryDeadline - Date.now()))
        const ready = this.#store.getById(id)
        if (!ready || ready.runtime?.generation !== generation || ready.runtime.claimId !== claimId || ready.runtime.state !== "ready") {
          throw new AgentUnavailableError(name)
        }
        return workerTarget(ready)
      } catch (error) {
        await stopWorker(worker)
        await this.#store.releaseRuntimeClaim(id, generation, claimId)
        throw error instanceof AgentUnavailableError ? error : new AgentUnavailableError(name)
      }
    }
    throw new AgentUnavailableError(name)
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("The pi-fleet client is closed")
  }
}

export async function connectPiFleet(options: ConnectOptions = {}): Promise<PiFleetClient> {
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")
  const stateDir = resolveStateDir(options)
  return new PiFleetClientImpl(await openStore(stateDir), stateDir)
}

export function resolveStateDir(options: ConnectOptions = {}): string {
  return options.stateDir ? resolve(options.stateDir) : resolve(homedir(), ".pi-fleet")
}

function normalizeReceiveOptions(options: ReceiveOptions): ReceiveOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new TypeError("Receive options must be an object")
  if (options.fromStart !== undefined && typeof options.fromStart !== "boolean") throw new TypeError("fromStart must be a boolean")
  if (options.fromStart !== undefined && options.after !== undefined) throw new TypeError("fromStart and after cannot be combined")
  if (options.after !== undefined) {
    if (typeof options.after !== "string" || !options.after.trim()) throw new TypeError("after must be a non-empty cursor")
    return { after: options.after }
  }
  return options.fromStart === true ? { fromStart: true } : {}
}

function isSendDelivery(value: unknown): value is SendDelivery {
  return value === "steer" || value === "followUp"
}

async function validateCreateOptions(options: CreateAgentOptions): Promise<{ name: string; cwd: string; piArgs: string[] }> {
  const name = options.name?.trim()
  if (!name) throw new TypeError("Agent name must not be empty")
  if (name.includes("\0")) throw new TypeError("Agent name must not contain a null byte")
  if (!options.cwd) throw new TypeError("Agent cwd is required")
  const cwd = resolve(options.cwd)
  if (!(await stat(cwd)).isDirectory()) throw new TypeError(`Agent cwd is not a directory: ${cwd}`)
  const piArgs = options.piArgs ? [...options.piArgs] : []
  validatePiArguments(piArgs)
  return { name, cwd, piArgs }
}

function trackStream(stream: WorkerEventStream, streams: Set<WorkerEventStream>): AsyncIterable<AgentEvent> {
  let claimed = false
  const release = () => streams.delete(stream)
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      if (claimed) throw new Error("An agent event stream can only be consumed once")
      claimed = true
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          try {
            const result = await stream.next()
            if (result.done) release()
            return result
          } catch (error) {
            release()
            throw error
          }
        },
        async return(): Promise<IteratorResult<AgentEvent>> {
          try {
            await stream.close()
            return { done: true, value: undefined }
          } finally {
            release()
          }
        },
        async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
          try {
            if (stream.throw) return await stream.throw(error)
            throw error
          } finally {
            await stream.close()
            release()
          }
        },
      }
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workerTarget(record: AgentRecord): WorkerTarget {
  return {
    id: record.id,
    name: record.name,
    runtime: record.runtime && { generation: record.runtime.generation, endpoint: record.runtime.endpoint },
  }
}

async function waitForWorkerReady(record: WorkerTarget, worker: ChildProcess, timeoutMs: number): Promise<void> {
  let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {}
  const exited = new Promise<never>((_, reject) => {
    onExit = (code, signal) => reject(new Error(`Worker exited before readiness (${signal ?? code ?? "unknown"})`))
    worker.once("exit", onExit)
  })
  try {
    await Promise.race([waitForStatus(record, timeoutMs), exited])
  } finally {
    worker.off("exit", onExit)
  }
}

async function waitForStatus(record: WorkerTarget, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < end) {
    try {
      await requestStatus(record, Math.min(500, end - Date.now()))
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Worker did not become ready")
}
