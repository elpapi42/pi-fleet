import { randomUUID } from "node:crypto"
import { capability } from "zeromq"
import type { ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { AgentHandle } from "./agent.js"
import { AgentNotFoundError, type Agent, type AgentStatus, type AgentSummary, type ConnectOptions, type CreateAgentOptions, type PiFleetClient, type SendDelivery, type SendOptions, type SendResult } from "./types.js"
import { resolveStateDir, workerEndpoint } from "./internal/paths.js"
import { openRegistry, type AgentRecord, type Registry } from "./internal/registry.js"
import { launchWorker } from "./internal/worker-launcher.js"
import { requestSend, requestStatus } from "./internal/worker-client.js"

const STARTUP_TIMEOUT_MS = 10_000
const OWNED_PI_OPTIONS = new Set(["--mode", "--no-session"])

class PiFleetClientImpl implements PiFleetClient {
  readonly #registry: Registry
  readonly #stateDir: string
  #closed = false

  constructor(registry: Registry, stateDir: string) {
    this.#registry = registry
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

    await this.#registry.create(record)
    let worker: ChildProcess | undefined
    try {
      worker = launchWorker(this.#stateDir, id, generation)
      await waitForWorkerReady(record, worker, STARTUP_TIMEOUT_MS)
      return new AgentHandle(this, id, input.name)
    } catch (error) {
      await stopWorker(worker)
      await this.#registry.rollbackCreation(id, input.name, generation)
      throw error
    }
  }

  async get(name: string): Promise<Agent> {
    this.assertOpen()
    const record = this.#registry.getByName(name)
    if (!record) throw new AgentNotFoundError(name)
    return new AgentHandle(this, record.id, record.name)
  }

  async list(): Promise<AgentSummary[]> {
    this.assertOpen()
    return this.#registry.list()
  }

  async status(id: string, name: string): Promise<AgentStatus> {
    this.assertOpen()
    const record = this.#registry.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    const status = await requestStatus(record)
    return { id: status.id, name: status.name, state: status.state }
  }

  async send(id: string, name: string, message: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertOpen()
    const record = this.#registry.getById(id)
    if (!record || record.name !== name) throw new AgentNotFoundError(name)
    if (typeof message !== "string" || !message.trim()) throw new TypeError("Message must not be empty")
    const delivery = options.delivery ?? "steer"
    if (!isSendDelivery(delivery)) throw new TypeError(`Invalid delivery: ${String(delivery)}`)
    return requestSend(record, message, delivery)
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    return this.#registry.close()
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("The pi-fleet client is closed")
  }
}

export async function connectPiFleet(options: ConnectOptions = {}): Promise<PiFleetClient> {
  if (!capability.ipc) throw new Error("pi-fleet requires ZeroMQ ipc:// support on this host")
  const stateDir = resolveStateDir(options)
  return new PiFleetClientImpl(await openRegistry(stateDir), stateDir)
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
  for (const arg of piArgs) {
    if (OWNED_PI_OPTIONS.has(arg) || [...OWNED_PI_OPTIONS].some((option) => arg.startsWith(`${option}=`))) {
      throw new TypeError(`Pi argument ${JSON.stringify(arg)} is managed by pi-fleet`)
    }
  }
  return { name, cwd, piArgs }
}

async function waitForWorkerReady(record: AgentRecord, worker: ChildProcess, timeoutMs: number): Promise<void> {
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

async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  worker.kill("SIGTERM")
  if (await waitForExit(worker, 1_000)) return
  worker.kill("SIGKILL")
  await waitForExit(worker, 1_000)
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

async function waitForStatus(record: AgentRecord, timeoutMs: number): Promise<void> {
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
