import { chmod, mkdir, realpath, rm } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
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
  destroying?: {
    requestedAt: number
    cleanupAfter: number
    runtimeGeneration: string
    claimId: string
  }
  lastEventSeq: number
  createdAt: number
  updatedAt: number
}

export type EventJournalEntry<Event = unknown> = {
  sequence: number
  cursor: string
  event: Event
}

export type RuntimeClaim = {
  generation: string
  claimId: string
  claimedAt: number
  endpoint: string
  workerPid?: number
}

export type RuntimeClaimResult<Event> = {
  record: AgentRecord
  interruption?: EventJournalEntry<Event>
}

export type DestroyOwner = {
  runtimeGeneration: string
  claimId: string
  requestedAt: number
}

export type DestroyResult<Event> = {
  record: AgentRecord
  event: EventJournalEntry<Event>
}

type EventCursorPayload = {
  agentId: string
  sequence: number
}

type SharedStore = {
  root: RootDatabase
  agents: Database<AgentRecord, string>
  names: Database<string, string>
  events: Database<EventJournalEntry>
  references: number
  closing?: Promise<void>
}

const MAX_EVENT_CURSOR_LENGTH = 4_096
const EVENT_CURSOR_PAYLOAD = /^[A-Za-z0-9_-]+$/
export const RUNTIME_CLAIM_WINDOW_MS = 30_000
export const DESTROY_CLEANUP_LEASE_MS = 30_000
const stores = new Map<string, SharedStore>()

export class FleetStore {
  readonly #stateDir: string
  readonly #shared: SharedStore
  readonly #agents: Database<AgentRecord, string>
  readonly #names: Database<string, string>
  readonly #events: Database<EventJournalEntry>
  #closed = false

  constructor(stateDir: string, shared: SharedStore) {
    this.#stateDir = stateDir
    this.#shared = shared
    this.#agents = shared.agents
    this.#names = shared.names
    this.#events = shared.events
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
    return [...this.#agents.getRange({})]
      .map(({ value }) => value)
      .filter((record) => !record.destroying)
  }

  async beginDestroy<Event>(id: string, name: string, owner: DestroyOwner, createEvent: (cursor: string) => Event): Promise<DestroyResult<Event> | undefined> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      const runtime = entry?.value.runtime
      if (!entry || entry.value.name !== name || entry.value.destroying || !runtime
        || runtime.generation !== owner.runtimeGeneration || runtime.claimId !== owner.claimId || runtime.state !== "ready"
        || this.#names.get(name) !== id) return undefined

      const version = entry.version ?? 0
      const sequence = entry.value.lastEventSeq + 1
      const cursor = encodeEventCursor(id, sequence)
      const event: EventJournalEntry<Event> = { sequence, cursor, event: createEvent(cursor) }
      const record: AgentRecord = {
        ...entry.value,
        destroying: {
          requestedAt: owner.requestedAt,
          cleanupAfter: owner.requestedAt + DESTROY_CLEANUP_LEASE_MS,
          runtimeGeneration: owner.runtimeGeneration,
          claimId: owner.claimId,
        },
        lastEventSeq: sequence,
        updatedAt: owner.requestedAt,
      }
      const admitted = await this.#agents.ifVersion(id, version, () => {
        this.#events.put([id, sequence], event)
        this.#names.remove(name)
        this.#agents.put(id, record, version + 1)
      })
      if (admitted) return { record, event }
    }
  }

  async deleteDestroyEventBatch(id: string, owner: NonNullable<AgentRecord["destroying"]>, limit: number): Promise<number | undefined> {
    this.assertOpen()
    if (limit < 1) return 0
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || !sameDestroyOwner(entry.value.destroying, owner)) return undefined
      const events = [...this.#events.getRange({
        start: [id, 0],
        end: [id, Number.MAX_SAFE_INTEGER],
        inclusiveEnd: true,
        limit,
      })]
      if (events.length === 0) return 0
      const version = entry.version ?? 0
      const deleted = await this.#agents.ifVersion(id, version, () => {
        for (const event of events) this.#events.remove(event.key)
      })
      if (deleted) return events.length
    }
  }

  async finishDestroy(id: string, owner: NonNullable<AgentRecord["destroying"]>): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || !sameDestroyOwner(entry.value.destroying, owner)) return false
      const [remaining] = [...this.#events.getRange({
        start: [id, 0],
        end: [id, Number.MAX_SAFE_INTEGER],
        inclusiveEnd: true,
        limit: 1,
      })]
      if (remaining) return false
      const version = entry.version ?? 0
      if (await this.#agents.ifVersion(id, version, () => this.#agents.remove(id))) return true
    }
  }

  async removeRuntimeEndpoint(endpoint: string | undefined): Promise<void> {
    this.assertOpen()
    await removeOwnedEndpoint(this.#stateDir, endpoint)
  }

  async completeDestroy(id: string, owner: NonNullable<AgentRecord["destroying"]>): Promise<boolean> {
    this.assertOpen()
    while ((await this.deleteDestroyEventBatch(id, owner, 128)) === 128) {}
    const record = this.#agents.get(id)
    if (!record || !sameDestroyOwner(record.destroying, owner)) return false
    await this.removeRuntimeEndpoint(record.runtime?.endpoint)
    return this.finishDestroy(id, owner)
  }

  async cleanupExpiredDestroys(now = Date.now()): Promise<number> {
    this.assertOpen()
    const expired = [...this.#agents.getRange({})]
      .map(({ value }) => value)
      .filter((record) => record.destroying && record.destroying.cleanupAfter <= now)
    let completed = 0
    for (const record of expired) {
      if (processGroupMayExist(record.runtime?.workerPid)) continue
      if (await this.completeDestroy(record.id, record.destroying!)) completed += 1
    }
    return completed
  }

  async markReady(id: string, runtimeGeneration: string, ready: Pick<NonNullable<AgentRecord["runtime"]>, "workerPid" | "endpoint"> & Pick<AgentRecord, "sessionPath" | "sessionId">): Promise<boolean> {
    this.assertOpen()
    const entry = this.#agents.getEntry(id)
    if (!entry || entry.value.destroying || entry.value.runtime?.generation !== runtimeGeneration) return false

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

  async claimRuntime<Event>(id: string, previousGeneration: string, claim: RuntimeClaim, createInterrupted: (cursor: string) => Event): Promise<RuntimeClaimResult<Event> | undefined> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      const previousRuntime = entry?.value.runtime
      if (!entry || entry.value.destroying || !previousRuntime || previousRuntime.generation !== previousGeneration) return undefined
      if (isFreshRuntimeClaim(previousRuntime, claim.claimedAt)) return undefined

      const version = entry.version ?? 0
      const interrupted = entry.value.state === "working" && previousRuntime.state === "ready"
      const sequence = entry.value.lastEventSeq + 1
      const cursor = encodeEventCursor(id, sequence)
      const interruption = interrupted
        ? { sequence, cursor, event: createInterrupted(cursor) }
        : undefined
      const record: AgentRecord = {
        ...entry.value,
        runtime: {
          ...previousRuntime,
          ...claim,
          workerPid: claim.workerPid ?? previousRuntime.workerPid,
          state: "starting",
        },
        lastEventSeq: interruption ? sequence : entry.value.lastEventSeq,
        updatedAt: claim.claimedAt,
      }
      const claimed = await this.#agents.ifVersion(id, version, () => {
        if (interruption) this.#events.put([id, sequence], interruption)
        this.#agents.put(id, record, version + 1)
      })
      if (claimed) return { record, interruption }
    }
  }

  async markClaimReady(id: string, runtimeGeneration: string, claimId: string, ready: Pick<NonNullable<AgentRecord["runtime"]>, "workerPid" | "endpoint"> & Pick<AgentRecord, "sessionPath" | "sessionId">): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      const runtime = entry?.value.runtime
      if (!entry || entry.value.destroying || !runtime || runtime.generation !== runtimeGeneration || runtime.claimId !== claimId || runtime.state !== "starting") return false

      const version = entry.version ?? 0
      const record: AgentRecord = {
        ...entry.value,
        sessionId: ready.sessionId,
        sessionPath: ready.sessionPath,
        state: "idle",
        runtime: {
          ...runtime,
          endpoint: ready.endpoint,
          workerPid: ready.workerPid,
          state: "ready",
        },
        updatedAt: Date.now(),
      }
      if (await this.#agents.put(id, record, version + 1, version)) return true
    }
  }

  async releaseRuntimeClaim(id: string, runtimeGeneration: string, claimId: string): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      const runtime = entry?.value.runtime
      if (!entry || entry.value.destroying || !runtime || runtime.generation !== runtimeGeneration || runtime.claimId !== claimId || runtime.state !== "starting") return false

      const version = entry.version ?? 0
      const record: AgentRecord = {
        ...entry.value,
        runtime: { ...runtime, claimId: undefined, claimedAt: undefined },
        updatedAt: Date.now(),
      }
      if (await this.#agents.put(id, record, version + 1, version)) return true
    }
  }

  isCurrentRuntimeClaim(id: string, runtimeGeneration: string, claimId: string): boolean {
    this.assertOpen()
    const record = this.#agents.get(id)
    const runtime = record?.runtime
    return !record?.destroying && runtime?.generation === runtimeGeneration && runtime.claimId === claimId
  }

  async markRecovered(id: string, runtimeGeneration: string, ready: Pick<AgentRecord, "sessionPath" | "sessionId">): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || entry.value.destroying || entry.value.runtime?.generation !== runtimeGeneration) return false
      const version = entry.version ?? 0
      const updated: AgentRecord = {
        ...entry.value,
        sessionPath: ready.sessionPath,
        sessionId: ready.sessionId,
        state: "idle",
        updatedAt: Date.now(),
      }
      if (await this.#agents.put(id, updated, version + 1, version)) return true
    }
  }

  async updateState(id: string, runtimeGeneration: string, state: "working" | "idle"): Promise<boolean> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || entry.value.destroying || entry.value.runtime?.generation !== runtimeGeneration) return false
      if (entry.value.state === state) return true

      const version = entry.version ?? 0
      const updated: AgentRecord = { ...entry.value, state, updatedAt: Date.now() }
      if (await this.#agents.put(id, updated, version + 1, version)) return true
    }
  }

  async appendEvent<Event>(id: string, runtimeGeneration: string, createEvent: (cursor: string) => Event): Promise<EventJournalEntry<Event> | undefined> {
    this.assertOpen()
    while (true) {
      const entry = this.#agents.getEntry(id)
      if (!entry || entry.value.destroying || entry.value.runtime?.generation !== runtimeGeneration) return undefined

      const version = entry.version ?? 0
      const sequence = entry.value.lastEventSeq + 1
      const cursor = encodeEventCursor(id, sequence)
      const event: EventJournalEntry<Event> = { sequence, cursor, event: createEvent(cursor) }
      const updated: AgentRecord = { ...entry.value, lastEventSeq: sequence, updatedAt: Date.now() }
      const appended = await this.#agents.ifVersion(id, version, () => {
        this.#events.put([id, sequence], event)
        this.#agents.put(id, updated, version + 1)
      })
      if (appended) return event
    }
  }

  readEvents<Event>(id: string, afterSequence: number, tailSequence: number, limit: number): EventJournalEntry<Event>[] {
    this.assertOpen()
    if (afterSequence >= tailSequence || limit < 1) return []
    return [...this.#events.getRange({
      start: [id, afterSequence],
      exclusiveStart: true,
      end: [id, tailSequence],
      inclusiveEnd: true,
      limit,
    })].map(({ value }) => value as EventJournalEntry<Event>)
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
      events: root.openDB<EventJournalEntry>("events", { encoding: "json" }),
      references: 0,
    }
    stores.set(canonicalStateDir, shared)
  }
  shared.references += 1
  const store = new FleetStore(canonicalStateDir, shared)
  await store.cleanupExpiredDestroys()
  return store
}

export function encodeEventCursor(agentId: string, sequence: number): string {
  return `pf1.${Buffer.from(JSON.stringify({ agentId, sequence })).toString("base64url")}`
}

export function decodeEventCursor(cursor: string): EventCursorPayload {
  if (typeof cursor !== "string" || cursor.length > MAX_EVENT_CURSOR_LENGTH || !cursor.startsWith("pf1.")) {
    throw new TypeError("Invalid event cursor")
  }
  const payload = cursor.slice(4)
  if (!EVENT_CURSOR_PAYLOAD.test(payload)) throw new TypeError("Invalid event cursor")
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!isEventCursorPayload(value) || encodeEventCursor(value.agentId, value.sequence) !== cursor) {
      throw new TypeError("Invalid event cursor")
    }
    return value
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid event cursor") throw error
    throw new TypeError("Invalid event cursor")
  }
}

function processGroupMayExist(workerPid: number | undefined): boolean {
  if (!workerPid || process.platform === "win32") return false
  try {
    process.kill(-workerPid, 0)
    return true
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
  }
}

async function removeOwnedEndpoint(stateDir: string, endpoint: string | undefined): Promise<void> {
  if (!endpoint?.startsWith("ipc://")) return
  const ipcDirectory = resolve(stateDir, "ipc")
  const endpointPath = resolve(endpoint.slice("ipc://".length))
  if (!endpointPath.startsWith(`${ipcDirectory}${sep}`) || !/^[a-f0-9]{24}\.sock$/.test(basename(endpointPath))) return
  await rm(endpointPath, { force: true })
}

function sameDestroyOwner(left: AgentRecord["destroying"], right: NonNullable<AgentRecord["destroying"]>): boolean {
  return left?.requestedAt === right.requestedAt
    && left.cleanupAfter === right.cleanupAfter
    && left.runtimeGeneration === right.runtimeGeneration
    && left.claimId === right.claimId
}

function isFreshRuntimeClaim(runtime: NonNullable<AgentRecord["runtime"]>, claimedAt: number): boolean {
  return runtime.state === "starting"
    && runtime.claimId !== undefined
    && runtime.claimedAt !== undefined
    && claimedAt - runtime.claimedAt <= RUNTIME_CLAIM_WINDOW_MS
}

function isEventCursorPayload(value: unknown): value is EventCursorPayload {
  return typeof value === "object"
    && value !== null
    && typeof (value as { agentId?: unknown }).agentId === "string"
    && (value as { agentId: string }).agentId.length > 0
    && Number.isSafeInteger((value as { sequence?: unknown }).sequence)
    && (value as { sequence: number }).sequence > 0
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
