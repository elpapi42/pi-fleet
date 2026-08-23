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
  type Agent,
  type AgentStatus,
  type AgentSummary,
  type SendDelivery,
  type SendOptions,
  type SendResult,
} from "./agent.js"
import { openStore, type AgentRecord, type FleetStore } from "../state/store.js"
import { launchWorker, requestSend, requestStatus, stopWorker, workerEndpoint, type WorkerTarget } from "../worker/control.js"
import { validatePiArguments } from "../pi/runtime.js"

const STARTUP_TIMEOUT_MS = 10_000

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
  #closed = false

  constructor(store: FleetStore, stateDir: string) {
    this.#store = store
    this.#stateDir = stateDir
  }

  async create(options: CreateAgentOptions): Promise<Agent> {
    this.assertOpen()
    const input = await validateCreateOptions(options)
    const id = randomUUID()
    const generation = randomUUID()
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
      },
      lastEventSeq: 0,
      createdAt: now,
      updatedAt: now,
    }

    if (!(await this.#store.create(record))) throw new AgentNameTakenError(input.name)

    let worker: ChildProcess | undefined
    try {
      worker = launchWorker(this.#stateDir, id, generation)
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
    const status = await requestStatus(workerTarget(record))
    return { id: status.id, name: status.name, state: status.state }
  }

  async send(id: string, name: string, message: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertOpen()
    const record = this.#store.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    if (typeof message !== "string" || !message.trim()) throw new TypeError("Message must not be empty")
    const delivery = options.delivery ?? "steer"
    if (!isSendDelivery(delivery)) throw new TypeError(`Invalid delivery: ${String(delivery)}`)
    return requestSend(workerTarget(record), message, delivery)
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    return this.#store.close()
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
