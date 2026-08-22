import { open, type Database, type RootDatabase } from "lmdb"
import { prepareStateDir } from "./paths.js"
import type { AgentState, AgentSummary } from "../types.js"
import { AgentNameTakenError } from "../types.js"

export type AgentRecord = {
  id: string
  name: string
  cwd: string
  instructions?: string
  piArgs: string[]
  sessionPath?: string
  sessionId?: string
  state: AgentState
  runtime?: {
    generation: string
    state: "starting" | "ready"
    workerPid?: number
    endpoint?: string
    claimId?: string
    claimedAt?: number
  }
  lastEventSeq: number
  createdAt: number
  updatedAt: number
}

type Environment = RootDatabase
type SharedEnvironment = {
  root: Environment
  agents: Database<AgentRecord, string>
  names: Database<string, string>
  references: number
  closing?: Promise<void>
}

const environments = new Map<string, SharedEnvironment>()

export class Registry {
  readonly #stateDir: string
  readonly #shared: SharedEnvironment
  readonly #agents: Database<AgentRecord, string>
  readonly #names: Database<string, string>
  #closed = false

  constructor(stateDir: string, shared: SharedEnvironment) {
    this.#stateDir = stateDir
    this.#shared = shared
    this.#agents = shared.agents
    this.#names = shared.names
  }

  async create(record: AgentRecord): Promise<void> {
    this.assertOpen()
    const created = await this.#names.ifNoExists(record.name, () => {
      this.#agents.put(record.id, record, 1)
      this.#names.put(record.name, record.id)
    })

    if (!created) throw new AgentNameTakenError(record.name)
  }

  getById(id: string): AgentRecord | undefined {
    this.assertOpen()
    return this.#agents.get(id)
  }

  getByName(name: string): AgentRecord | undefined {
    this.assertOpen()
    const id = this.#names.get(name)
    return id === undefined ? undefined : this.#agents.get(id)
  }

  list(): AgentSummary[] {
    this.assertOpen()
    return [...this.#agents.getRange({})].map(({ value }) => ({
      id: value.id,
      name: value.name,
      cwd: value.cwd,
      state: value.state,
    }))
  }

  async markReady(id: string, runtimeGeneration: string, ready: Pick<NonNullable<AgentRecord["runtime"]>, "workerPid" | "endpoint"> & Pick<AgentRecord, "sessionPath" | "sessionId">): Promise<boolean> {
    this.assertOpen()
    const entry = this.#agents.getEntry(id)
    if (!entry || entry.value.runtime?.generation !== runtimeGeneration) return false

    const { endpoint, workerPid, sessionId, sessionPath } = ready
    const record: AgentRecord = {
      ...entry.value,
      sessionId,
      sessionPath,
      state: "idle",
      runtime: {
        ...entry.value.runtime,
        endpoint,
        workerPid,
        state: "ready",
      },
      updatedAt: Date.now(),
    }
    const version = entry.version ?? 0
    return this.#agents.put(id, record, version + 1, version)
  }

  async rollbackCreation(id: string, name: string, runtimeGeneration: string): Promise<void> {
    this.assertOpen()
    await this.#names.transaction(() => {
      const record = this.#agents.get(id)
      if (this.#names.get(name) !== id || record?.runtime?.generation !== runtimeGeneration) return
      this.#agents.remove(id)
      this.#names.remove(name)
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#shared.references -= 1
    if (this.#shared.references > 0) return

    const closing = this.#shared.root.close()
    this.#shared.closing = closing
    try {
      await closing
    } finally {
      if (environments.get(this.#stateDir) === this.#shared) environments.delete(this.#stateDir)
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("The pi-fleet client is closed")
  }
}

export async function openRegistry(stateDir: string): Promise<Registry> {
  const canonicalStateDir = await prepareStateDir(stateDir)
  let shared = environments.get(canonicalStateDir)
  if (shared?.closing) {
    await shared.closing
    shared = environments.get(canonicalStateDir)
  }
  if (!shared) {
    const root = open({ path: canonicalStateDir, maxDbs: 3 })
    shared = {
      root,
      agents: root.openDB<AgentRecord, string>("agents", { encoding: "json", useVersions: true }),
      names: root.openDB<string, string>("names", { encoding: "string" }),
      references: 0,
    }
    environments.set(canonicalStateDir, shared)
  }
  shared.references += 1
  return new Registry(canonicalStateDir, shared)
}
