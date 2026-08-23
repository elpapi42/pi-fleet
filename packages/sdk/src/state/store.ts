import { chmod, mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { open, type Database, type RootDatabase } from "lmdb"
import type { AgentState } from "../fleet/agent.js"

export type AgentRecord = {
  id: string
  name: string
  cwd: string
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

type SharedStore = {
  root: RootDatabase
  agents: Database<AgentRecord, string>
  names: Database<string, string>
  references: number
  closing?: Promise<void>
}

const stores = new Map<string, SharedStore>()

export class FleetStore {
  readonly #stateDir: string
  readonly #shared: SharedStore
  readonly #agents: Database<AgentRecord, string>
  readonly #names: Database<string, string>
  #closed = false

  constructor(stateDir: string, shared: SharedStore) {
    this.#stateDir = stateDir
    this.#shared = shared
    this.#agents = shared.agents
    this.#names = shared.names
  }

  async create(record: AgentRecord): Promise<boolean> {
    this.assertOpen()
    return this.#names.ifNoExists(record.name, () => {
      this.#agents.put(record.id, record, 1)
      this.#names.put(record.name, record.id)
    })
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

  list(): AgentRecord[] {
    this.assertOpen()
    return [...this.#agents.getRange({})].map(({ value }) => value)
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

  async updateState(id: string, runtimeGeneration: string, state: "working" | "idle"): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || entry.value.runtime?.generation !== runtimeGeneration) return false
      if (entry.value.state === state) return true

      const version = entry.version ?? 0
      const updated: AgentRecord = { ...entry.value, state, updatedAt: Date.now() }
      if (await this.#agents.put(id, updated, version + 1, version)) return true
    }
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
      if (stores.get(this.#stateDir) === this.#shared) stores.delete(this.#stateDir)
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("The pi-fleet client is closed")
  }
}

export async function openStore(stateDir: string): Promise<FleetStore> {
  const canonicalStateDir = await prepareStateDirectory(stateDir)
  let shared = stores.get(canonicalStateDir)
  if (shared?.closing) {
    await shared.closing
    shared = stores.get(canonicalStateDir)
  }
  if (!shared) {
    const root = open({ path: canonicalStateDir, maxDbs: 3 })
    shared = {
      root,
      agents: root.openDB<AgentRecord, string>("agents", { encoding: "json", useVersions: true }),
      names: root.openDB<string, string>("names", { encoding: "string" }),
      references: 0,
    }
    stores.set(canonicalStateDir, shared)
  }
  shared.references += 1
  return new FleetStore(canonicalStateDir, shared)
}

async function prepareStateDirectory(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  const canonicalStateDir = await realpath(stateDir)
  const ipcDir = join(canonicalStateDir, "ipc")
  await mkdir(ipcDir, { recursive: true, mode: 0o700 })
  await chmod(ipcDir, 0o700)
  return canonicalStateDir
}
