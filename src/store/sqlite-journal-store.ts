import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  hardenPrivateDirectorySync,
  hardenSqliteSidecarsSync,
} from "../platform/shared/state-security.js";
import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
  RawRpcRecord,
} from "../runtime/semantic-events.js";
import {
  assertJournalAgentIdentity,
  assertJournalAppend,
  boundedSemanticEvents,
  sameJournalDestroyReceipt,
} from "./journal-store.js";
import type {
  JournalAgent,
  JournalAppend,
  JournalCompact,
  JournalDestroyReceipt,
  JournalEpoch,
  JournalEventRange,
  JournalHighWater,
  JournalIncarnation,
  JournalMaintenanceResult,
  JournalOperation,
  JournalReceiveSnapshot,
  JournalSend,
  JournalStorageDiagnostics,
  JournalStore,
  StoredSemanticEvent,
} from "./journal-store.js";

export const JOURNAL_SCHEMA_VERSION = 3;
export const JOURNAL_SCHEMA_CHECKSUM = "003_uuid_journal_v3";
export const LEGACY_JOURNAL_SCHEMA_CHECKSUMS = new Map([
  [1, "001_initial_v1"],
  [2, "002_compact_v1"],
]);

export interface JournalMigrationRow {
  readonly version: number;
  readonly checksum: string;
}

export type JournalMigrationState = "fresh" | "legacy" | "current";

export function classifyJournalMigrationRows(
  rows: readonly JournalMigrationRow[],
): JournalMigrationState {
  if (rows.length === 0) return "fresh";
  for (const row of rows) {
    if (!Number.isSafeInteger(row.version) || typeof row.checksum !== "string") {
      throw new Error("pi-fleet database migration ledger is malformed");
    }
  }
  if (rows.length === 1 && rows[0]?.version === JOURNAL_SCHEMA_VERSION) {
    if (rows[0].checksum !== JOURNAL_SCHEMA_CHECKSUM) {
      throw new Error(
        `pi-fleet database migration ${String(JOURNAL_SCHEMA_VERSION)} checksum mismatch`,
      );
    }
    return "current";
  }
  const legacyOne = rows.length === 1 && rows[0]?.version === 1;
  const legacyTwo = rows.length === 2 && rows[0]?.version === 1 && rows[1]?.version === 2;
  if (legacyOne || legacyTwo) {
    for (const row of rows) {
      if (LEGACY_JOURNAL_SCHEMA_CHECKSUMS.get(row.version) !== row.checksum) {
        throw new Error(`pi-fleet database migration ${String(row.version)} checksum mismatch`);
      }
    }
    return "legacy";
  }
  const newer = rows.find((row) => row.version > JOURNAL_SCHEMA_VERSION);
  if (newer !== undefined) {
    throw new Error(`pi-fleet database schema ${String(newer.version)} is newer than this runtime`);
  }
  throw new Error("pi-fleet database migration ledger sequence is invalid");
}

interface JsonRow {
  readonly data_json: string;
}

function* parseSemanticEventRows(rows: Iterable<JsonRow>): Iterable<StoredSemanticEvent> {
  for (const row of rows) yield JSON.parse(row.data_json) as StoredSemanticEvent;
}

export interface SqliteJournalStoreOptions {
  readonly checkpointCommitInterval?: number;
  readonly reclaimPagesPerPass?: number;
  readonly now?: () => string;
}

const idleMaintenance = (): JournalMaintenanceResult => ({
  state: "idle",
  lastCheckpointAt: null,
  busy: false,
  logFrames: 0,
  checkpointedFrames: 0,
  autoVacuumMode: "none",
  freelistPagesBefore: 0,
  freelistPagesAfter: 0,
  requestedReclaimPages: 0,
});

export class SqliteJournalStore implements JournalStore {
  readonly #database: DatabaseSync;
  readonly #checkpointCommitInterval: number;
  readonly #reclaimPagesPerPass: number;
  readonly #now: () => string;
  #commitsSinceCheckpoint = 0;
  #lastAppendDurationMs: number | null = null;
  #storageFailureLatched = false;
  #maintenance = idleMaintenance();
  #closed = false;

  constructor(path: string, options: SqliteJournalStoreOptions = {}) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenPrivateDirectorySync(directory);
    hardenSqliteSidecarsSync(path);
    this.#checkpointCommitInterval = positiveInteger(
      options.checkpointCommitInterval ?? 128,
      "Journal checkpoint commit interval",
    );
    this.#reclaimPagesPerPass = positiveInteger(
      options.reclaimPagesPerPass ?? 32,
      "Journal reclaim pages per pass",
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA auto_vacuum=INCREMENTAL; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    hardenSqliteSidecarsSync(path);
    try {
      const integrity = this.#database.prepare("PRAGMA quick_check").get() as
        | { quick_check?: string }
        | undefined;
      if (integrity?.quick_check !== "ok") throw new Error("pi-fleet database quick_check failed");
      this.#migrate();
      this.#database
        .prepare(
          "UPDATE journal_runtime_health SET clean_shutdown = 0, started_at = ? WHERE singleton_key = 1",
        )
        .run(new Date().toISOString());
    } catch (error: unknown) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async createAgent(agent: JournalAgent): Promise<boolean> {
    this.#assertOpen();
    assertJournalAgentIdentity(agent);
    const result = this.#database
      .prepare("INSERT OR IGNORE INTO journal_agents(agent_id, name, data_json) VALUES(?, ?, ?)")
      .run(agent.agentId, agent.name, JSON.stringify(agent));
    return result.changes === 1;
  }

  async createAgentWithOperation(
    agent: JournalAgent,
    operation: JournalOperation,
  ): Promise<boolean> {
    this.#assertOpen();
    assertJournalAgentIdentity(agent);
    if (operation.agentId !== agent.agentId || operation.targetName !== agent.name) {
      throw new Error("Create operation does not target the provisional agent");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = await this.getOperation(operation.operationId);
      if (
        existing !== null &&
        (existing.method !== operation.method ||
          existing.fingerprint !== operation.fingerprint ||
          (existing.agentId !== null && existing.agentId !== agent.agentId))
      ) {
        throw new Error("Operation was already used with a different request");
      }
      const created =
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO journal_agents(agent_id, name, data_json) VALUES(?, ?, ?)",
          )
          .run(agent.agentId, agent.name, JSON.stringify(agent)).changes === 1;
      if (created) this.#putOperationSync(operation);
      this.#database.exec("COMMIT");
      return created;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async rollbackProvisionalCreate(
    agentId: AgentId,
    completedOperation: JournalOperation,
  ): Promise<JournalAgent | null> {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = await this.getAgentById(agentId);
      const pending = await this.getOperation(completedOperation.operationId);
      if (existing === null) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      if (
        pending === null ||
        pending.method !== "create" ||
        pending.state !== "pending" ||
        pending.agentId !== agentId ||
        pending.targetName !== existing.name ||
        completedOperation.method !== "create" ||
        completedOperation.state !== "completed" ||
        completedOperation.agentId !== null ||
        completedOperation.targetName !== existing.name ||
        completedOperation.fingerprint !== pending.fingerprint
      ) {
        throw new Error("Provisional create rollback does not match the pending operation");
      }
      this.#database
        .prepare("DELETE FROM journal_operations WHERE agent_id = ? AND operation_id <> ?")
        .run(agentId, completedOperation.operationId);
      this.#putOperationSync(completedOperation);
      this.#database.prepare("DELETE FROM journal_agents WHERE agent_id = ?").run(agentId);
      this.#database.exec("COMMIT");
      return existing;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async getAgentByName(name: string): Promise<JournalAgent | null> {
    return this.#readJson<JournalAgent>(
      "SELECT data_json FROM journal_agents WHERE name = ?",
      name,
    );
  }

  async getAgentById(agentId: AgentId): Promise<JournalAgent | null> {
    return this.#readJson<JournalAgent>(
      "SELECT data_json FROM journal_agents WHERE agent_id = ?",
      agentId,
    );
  }

  async listAgents(): Promise<readonly JournalAgent[]> {
    return this.#readJsonRows<JournalAgent>("SELECT data_json FROM journal_agents ORDER BY name");
  }

  async putAgent(agent: JournalAgent): Promise<void> {
    this.#assertOpen();
    assertJournalAgentIdentity(agent);
    this.#database
      .prepare(
        `INSERT INTO journal_agents(agent_id, name, data_json) VALUES(?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name, data_json=excluded.data_json`,
      )
      .run(agent.agentId, agent.name, JSON.stringify(agent));
  }

  async putOperation(operation: JournalOperation): Promise<void> {
    this.#putOperationSync(operation);
  }

  async getOperation(operationId: string): Promise<JournalOperation | null> {
    return this.#readJson<JournalOperation>(
      "SELECT data_json FROM journal_operations WHERE operation_id = ?",
      operationId,
    );
  }

  async listPendingOperations(): Promise<readonly JournalOperation[]> {
    return this.#readJsonRows<JournalOperation>(
      "SELECT data_json FROM journal_operations WHERE json_extract(data_json, '$.state') = 'pending' ORDER BY rowid",
    );
  }

  async deleteOperation(operationId: string): Promise<void> {
    this.#assertOpen();
    this.#database
      .prepare("DELETE FROM journal_operations WHERE operation_id = ?")
      .run(operationId);
  }

  async putSend(send: JournalSend): Promise<void> {
    this.#putOwned("journal_sends", "send_id", send.sendId, send.agentId, send);
  }

  async getSend(sendId: string): Promise<JournalSend | null> {
    return this.#readJson<JournalSend>(
      "SELECT data_json FROM journal_sends WHERE send_id = ?",
      sendId,
    );
  }

  async nextSendOrdinal(agentId: AgentId): Promise<number> {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(MAX(CAST(json_extract(data_json, '$.ordinal') AS INTEGER)), 0) + 1 AS ordinal
         FROM journal_sends WHERE agent_id = ?`,
      )
      .get(agentId) as { readonly ordinal: number };
    return row.ordinal;
  }

  async listNonterminalSends(): Promise<readonly JournalSend[]> {
    return this.#readJsonRows<JournalSend>(
      `SELECT data_json FROM journal_sends
       WHERE json_extract(data_json, '$.state') IN ('pending', 'dispatching')
       ORDER BY CAST(json_extract(data_json, '$.ordinal') AS INTEGER), rowid`,
    );
  }

  async putCompact(compact: JournalCompact): Promise<void> {
    this.#putOwned("journal_compacts", "compact_id", compact.compactId, compact.agentId, compact);
  }

  async getCompact(compactId: string): Promise<JournalCompact | null> {
    return this.#readJson<JournalCompact>(
      "SELECT data_json FROM journal_compacts WHERE compact_id = ?",
      compactId,
    );
  }

  async listNonterminalCompacts(): Promise<readonly JournalCompact[]> {
    return this.#readJsonRows<JournalCompact>(
      `SELECT data_json FROM journal_compacts
       WHERE json_extract(data_json, '$.state') IN ('pending', 'dispatching') ORDER BY rowid`,
    );
  }

  async putIncarnation(incarnation: JournalIncarnation): Promise<void> {
    this.#putOwned(
      "journal_incarnations",
      "incarnation_id",
      incarnation.incarnationId,
      incarnation.agentId,
      incarnation,
    );
  }

  async listActiveIncarnations(): Promise<readonly JournalIncarnation[]> {
    return this.#readJsonRows<JournalIncarnation>(
      `SELECT data_json FROM journal_incarnations
       WHERE json_extract(data_json, '$.state') IN
         ('starting', 'live', 'stopping', 'cleanup_uncertain') ORDER BY rowid`,
    );
  }

  async putEpoch(epoch: JournalEpoch): Promise<void> {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO journal_epochs(agent_id, epoch, state, data_json) VALUES(?, ?, ?, ?)
         ON CONFLICT(agent_id, epoch) DO UPDATE SET
           state=excluded.state, data_json=excluded.data_json`,
      )
      .run(epoch.agentId, epoch.epoch, epoch.state, JSON.stringify(epoch));
  }

  async getEpochs(agentId: AgentId): Promise<readonly JournalEpoch[]> {
    return this.#readJsonRows<JournalEpoch>(
      "SELECT data_json FROM journal_epochs WHERE agent_id = ? ORDER BY epoch",
      agentId,
    );
  }

  async beginIncarnation(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
    projectorState: ProjectorState,
  ): Promise<void> {
    this.#assertOpen();
    const incarnation = this.#database
      .prepare("SELECT 1 FROM journal_incarnations WHERE agent_id = ? AND incarnation_id = ?")
      .get(agentId, incarnationId);
    const epochRow = this.#database
      .prepare("SELECT state FROM journal_epochs WHERE agent_id = ? AND epoch = ?")
      .get(agentId, epoch) as { readonly state: string } | undefined;
    if (incarnation === undefined) {
      throw new Error("Projector binding references an unknown incarnation");
    }
    if (epochRow?.state !== "open") {
      throw new Error("Projector binding requires an open continuity epoch");
    }
    this.#database
      .prepare(
        `INSERT INTO journal_projector_state(
           agent_id, incarnation_id, epoch, data_json
         ) VALUES(?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           incarnation_id=excluded.incarnation_id,
           epoch=excluded.epoch,
           data_json=excluded.data_json`,
      )
      .run(agentId, incarnationId, epoch, JSON.stringify(projectorState));
  }

  async append(batch: JournalAppend): Promise<void> {
    this.#assertOpen();
    const startedAt = performance.now();
    let transactionOpen = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const current = this.#getHighWaterSync(batch.agentId) ?? {
        rawPosition: 0,
        eventPosition: 0,
        idleEventPosition: null,
      };
      const epochRow = this.#database
        .prepare("SELECT data_json FROM journal_epochs WHERE agent_id = ? AND epoch = ?")
        .get(batch.agentId, batch.epoch) as JsonRow | undefined;
      assertJournalAppend(
        batch,
        current,
        epochRow === undefined ? null : (JSON.parse(epochRow.data_json) as JournalEpoch),
      );
      const projectorBinding = this.#database
        .prepare(
          `SELECT incarnation_id, epoch FROM journal_projector_state
           WHERE agent_id = ?`,
        )
        .get(batch.agentId) as
        | { readonly incarnation_id: string; readonly epoch: number }
        | undefined;
      if (
        projectorBinding?.incarnation_id !== batch.incarnationId ||
        projectorBinding.epoch !== batch.epoch
      ) {
        throw new Error("Journal append does not match the active projector incarnation");
      }
      const putRecord = this.#database.prepare(
        `INSERT INTO journal_raw_records(
          agent_id, raw_position, incarnation_id, epoch, observed_at, record_bytes
        ) VALUES(?, ?, ?, ?, ?, ?)`,
      );
      for (const record of batch.records) {
        putRecord.run(
          record.agentId,
          record.position,
          record.incarnationId,
          batch.epoch,
          record.observedAt,
          record.bytes,
        );
      }
      const putEvent = this.#database.prepare(
        `INSERT INTO journal_semantic_events(
          agent_id, event_position, event_id, event_epoch, raw_position, event_type, data_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const stored of batch.events) {
        putEvent.run(
          stored.agentId,
          stored.position,
          stored.event.id,
          stored.event.epoch,
          stored.event.sourceRawPosition,
          stored.event.type,
          JSON.stringify(stored),
        );
      }
      this.#database
        .prepare(
          `UPDATE journal_projector_state SET data_json = ?
           WHERE agent_id = ? AND incarnation_id = ? AND epoch = ?`,
        )
        .run(JSON.stringify(batch.projectorState), batch.agentId, batch.incarnationId, batch.epoch);
      this.#database
        .prepare(
          `INSERT INTO journal_high_water(
             agent_id, raw_position, event_position, idle_event_position
           ) VALUES(?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             raw_position=excluded.raw_position,
             event_position=excluded.event_position,
             idle_event_position=excluded.idle_event_position`,
        )
        .run(
          batch.agentId,
          batch.highWater.rawPosition,
          batch.highWater.eventPosition,
          batch.highWater.idleEventPosition,
        );
      this.#database
        .prepare(
          `UPDATE journal_runtime_health SET last_commit_at = ?
           WHERE singleton_key = 1`,
        )
        .run(new Date().toISOString());
      this.#database.exec("COMMIT");
      transactionOpen = false;
    } catch (error: unknown) {
      if (transactionOpen) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // The original durability failure remains authoritative when rollback also fails.
        }
      }
      this.#latchStorageFailure();
      throw error;
    } finally {
      this.#lastAppendDurationMs = Math.max(0, performance.now() - startedAt);
    }
    this.#commitsSinceCheckpoint += 1;
    if (this.#commitsSinceCheckpoint >= this.#checkpointCommitInterval) {
      await this.maintain(0);
    }
  }

  async openReceive(agentId: AgentId): Promise<JournalReceiveSnapshot | null> {
    this.#assertOpen();
    this.#database.exec("BEGIN");
    try {
      const agent = this.#readJson<JournalAgent>(
        "SELECT data_json FROM journal_agents WHERE agent_id = ?",
        agentId,
      );
      if (agent === null) {
        this.#database.exec("COMMIT");
        return null;
      }
      const snapshot = {
        agent,
        epochs: this.#readJsonRows<JournalEpoch>(
          "SELECT data_json FROM journal_epochs WHERE agent_id = ? ORDER BY epoch",
          agentId,
        ),
        highWater: this.#getHighWaterSync(agentId) ?? {
          rawPosition: 0,
          eventPosition: 0,
          idleEventPosition: null,
        },
      } satisfies JournalReceiveSnapshot;
      this.#database.exec("COMMIT");
      return snapshot;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async readEvents(range: JournalEventRange): Promise<readonly StoredSemanticEvent[]> {
    const rows = this.#database
      .prepare(
        `SELECT data_json FROM journal_semantic_events
         WHERE agent_id = ? AND event_epoch = ? AND event_position > ?
         ORDER BY event_position LIMIT ?`,
      )
      .iterate(range.agentId, range.epoch, range.afterPosition, range.limit) as Iterable<JsonRow>;
    return boundedSemanticEvents(parseSemanticEventRows(rows), range);
  }

  async getProjectorState(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
  ): Promise<ProjectorState | null> {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT incarnation_id, epoch, data_json FROM journal_projector_state
         WHERE agent_id = ?`,
      )
      .get(agentId) as
      | { readonly incarnation_id: string; readonly epoch: number; readonly data_json: string }
      | undefined;
    if (row === undefined) return null;
    if (row.incarnation_id !== incarnationId || row.epoch !== epoch) {
      throw new Error("Projector state belongs to another incarnation or continuity epoch");
    }
    return JSON.parse(row.data_json) as ProjectorState;
  }

  async getHighWater(agentId: AgentId): Promise<JournalHighWater | null> {
    return this.#getHighWaterSync(agentId);
  }

  async markIdle(agentId: AgentId, epoch: ContinuityEpoch): Promise<number> {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const epochRow = this.#database
        .prepare("SELECT state FROM journal_epochs WHERE agent_id = ? AND epoch = ?")
        .get(agentId, epoch) as { readonly state: string } | undefined;
      if (epochRow?.state !== "open") throw new Error("Idle marker requires an open epoch");
      const current = this.#getHighWaterSync(agentId) ?? {
        rawPosition: 0,
        eventPosition: 0,
        idleEventPosition: null,
      };
      this.#database
        .prepare(
          `INSERT INTO journal_high_water(
             agent_id, raw_position, event_position, idle_event_position
           ) VALUES(?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             idle_event_position=excluded.idle_event_position`,
        )
        .run(agentId, current.rawPosition, current.eventPosition, current.eventPosition);
      this.#database
        .prepare("UPDATE journal_runtime_health SET last_commit_at = ? WHERE singleton_key = 1")
        .run(new Date().toISOString());
      this.#database.exec("COMMIT");
      return current.eventPosition;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      this.#latchStorageFailure();
      throw error;
    }
  }

  async getRawRecords(
    agentId: AgentId,
    afterPosition: number,
    limit: number,
  ): Promise<readonly RawRpcRecord[]> {
    this.#assertPositiveLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT raw_position, incarnation_id, observed_at, record_bytes
         FROM journal_raw_records WHERE agent_id = ? AND raw_position > ?
         ORDER BY raw_position LIMIT ?`,
      )
      .all(agentId, afterPosition, limit) as unknown as Array<{
      readonly raw_position: number;
      readonly incarnation_id: string;
      readonly observed_at: string;
      readonly record_bytes: Uint8Array;
    }>;
    return rows.map((row) => ({
      agentId,
      incarnationId: row.incarnation_id as RawRpcRecord["incarnationId"],
      position: row.raw_position,
      observedAt: row.observed_at,
      bytes: Buffer.from(row.record_bytes),
    }));
  }

  async destroyAgent(
    agentId: AgentId,
    receipt: JournalDestroyReceipt,
  ): Promise<JournalAgent | null> {
    this.#assertOpen();
    if (receipt.agentId !== agentId) throw new Error("Destroy receipt targets another agent");
    let destroyed: JournalAgent | null = null;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const priorReceipt = await this.getDestroyReceipt(receipt.operationId);
      if (priorReceipt !== null) {
        if (!sameJournalDestroyReceipt(priorReceipt, receipt)) {
          throw new Error("Destroy operation was already used");
        }
        this.#database.exec("ROLLBACK");
        return null;
      }
      const existing = await this.getAgentById(agentId);
      if (existing === null) {
        this.#database.exec("ROLLBACK");
        return null;
      }
      this.#database.prepare("DELETE FROM journal_operations WHERE agent_id = ?").run(agentId);
      this.#database.prepare("DELETE FROM journal_agents WHERE agent_id = ?").run(agentId);
      this.#database
        .prepare(
          `INSERT INTO journal_destroy_receipts(
             operation_id, agent_id, agent_name, fingerprint, destroyed_at, status
           ) VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(operation_id) DO NOTHING`,
        )
        .run(
          receipt.operationId,
          receipt.agentId,
          receipt.agentName,
          receipt.fingerprint,
          receipt.destroyedAt,
          receipt.status,
        );
      this.#database.exec("COMMIT");
      destroyed = existing;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    await this.maintain(this.#reclaimPagesPerPass);
    return destroyed;
  }

  async getDestroyReceipt(operationId: string): Promise<JournalDestroyReceipt | null> {
    const row = this.#database
      .prepare(
        `SELECT operation_id, agent_id, agent_name, fingerprint, destroyed_at, status
         FROM journal_destroy_receipts WHERE operation_id = ?`,
      )
      .get(operationId) as
      | {
          readonly operation_id: string;
          readonly agent_id: string;
          readonly agent_name: string;
          readonly fingerprint: string;
          readonly destroyed_at: string;
          readonly status: "destroyed";
        }
      | undefined;
    return row === undefined
      ? null
      : {
          operationId: row.operation_id,
          agentId: row.agent_id as AgentId,
          agentName: row.agent_name,
          fingerprint: row.fingerprint,
          destroyedAt: row.destroyed_at,
          status: row.status,
        };
  }

  async maintain(reclaimPages = this.#reclaimPagesPerPass): Promise<JournalMaintenanceResult> {
    this.#assertOpen();
    if (!Number.isSafeInteger(reclaimPages) || reclaimPages < 0) {
      throw new Error("Journal reclaim page limit must be a non-negative integer");
    }
    this.#maintenance = {
      ...this.#maintenance,
      state: "running",
      requestedReclaimPages: reclaimPages,
    };
    try {
      const checkpoint = this.#database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
      };
      const autoVacuumValue = pragmaInteger(this.#database, "auto_vacuum");
      const freelistPagesBefore = pragmaInteger(this.#database, "freelist_count");
      if (reclaimPages > 0 && autoVacuumValue === 2 && freelistPagesBefore > 0) {
        this.#database.exec(`PRAGMA incremental_vacuum(${String(reclaimPages)})`);
      }
      const result: JournalMaintenanceResult = {
        state: "idle",
        lastCheckpointAt: this.#now(),
        busy: checkpoint.busy !== 0,
        logFrames: checkpoint.log,
        checkpointedFrames: checkpoint.checkpointed,
        autoVacuumMode: autoVacuumMode(autoVacuumValue),
        freelistPagesBefore,
        freelistPagesAfter: pragmaInteger(this.#database, "freelist_count"),
        requestedReclaimPages: reclaimPages,
      };
      this.#maintenance = result;
      this.#commitsSinceCheckpoint = 0;
      return { ...result };
    } catch (error: unknown) {
      this.#maintenance = { ...this.#maintenance, state: "failed" };
      this.#latchStorageFailure();
      throw error;
    }
  }

  async getDiagnostics(): Promise<JournalStorageDiagnostics> {
    const retainedByAgent = this.#database
      .prepare(
        `SELECT a.agent_id,
          (SELECT COUNT(*) FROM journal_raw_records r
             WHERE r.agent_id = a.agent_id) AS raw_record_count,
          (SELECT COALESCE(SUM(length(r.record_bytes)), 0) FROM journal_raw_records r
             WHERE r.agent_id = a.agent_id) AS raw_bytes,
          (SELECT COUNT(*) FROM journal_semantic_events e
             WHERE e.agent_id = a.agent_id) AS semantic_event_count
         FROM journal_agents a ORDER BY a.agent_id`,
      )
      .all() as unknown as Array<{
      readonly agent_id: string;
      readonly raw_record_count: number;
      readonly raw_bytes: number;
      readonly semantic_event_count: number;
    }>;
    const row = this.#database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM journal_raw_records) AS raw_record_count,
          (SELECT COALESCE(SUM(length(record_bytes)), 0) FROM journal_raw_records) AS raw_bytes,
          (SELECT COUNT(*) FROM journal_semantic_events) AS semantic_event_count,
          (SELECT COUNT(*) FROM journal_agents) AS agent_count,
          (SELECT COALESCE(SUM(json_array_length(data_json, '$.openActivities')), 0)
             FROM journal_projector_state) AS open_projector_activities,
          (SELECT COUNT(*) FROM journal_epochs
             WHERE state = 'closed'
               AND json_extract(data_json, '$.reason') = 'observation_uncertain')
             AS continuity_gap_count,
          (SELECT storage_state FROM journal_runtime_health WHERE singleton_key = 1) AS storage_state,
          (SELECT last_commit_at FROM journal_runtime_health WHERE singleton_key = 1) AS last_commit_at`,
      )
      .get() as {
      readonly raw_record_count: number;
      readonly raw_bytes: number;
      readonly semantic_event_count: number;
      readonly agent_count: number;
      readonly open_projector_activities: number;
      readonly continuity_gap_count: number;
      readonly storage_state: "healthy" | "failed";
      readonly last_commit_at: string | null;
    };
    return {
      rawRecordCount: row.raw_record_count,
      rawBytes: row.raw_bytes,
      semanticEventCount: row.semantic_event_count,
      agentCount: row.agent_count,
      retainedByAgent: retainedByAgent.map((agent) => ({
        agentId: agent.agent_id as AgentId,
        rawRecordCount: agent.raw_record_count,
        rawBytes: agent.raw_bytes,
        semanticEventCount: agent.semantic_event_count,
      })),
      openProjectorActivities: row.open_projector_activities,
      continuityGapCount: row.continuity_gap_count,
      storageState: this.#storageFailureLatched ? "failed" : row.storage_state,
      lastCommitAt: row.last_commit_at,
      lastAppendDurationMs: this.#lastAppendDurationMs,
      maintenance: { ...this.#maintenance },
    };
  }

  #latchStorageFailure(): void {
    this.#storageFailureLatched = true;
    try {
      this.#database
        .prepare(
          "UPDATE journal_runtime_health SET storage_state = 'failed' WHERE singleton_key = 1",
        )
        .run();
    } catch {
      // The in-memory latch remains authoritative until an explicit recovery design exists.
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database
      .prepare("UPDATE journal_runtime_health SET clean_shutdown = 1 WHERE singleton_key = 1")
      .run();
    this.#database.close();
    this.#closed = true;
  }

  #migrate(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations(
          version INTEGER PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )`,
      );
      const applied = this.#database
        .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
        .all() as unknown as JournalMigrationRow[];
      const migrationState = classifyJournalMigrationRows(applied);
      if (migrationState === "current") {
        this.#database.exec("COMMIT");
        return;
      }
      this.#replaceLegacySchema();
      this.#database.prepare("DELETE FROM schema_migrations").run();
      this.#database
        .prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)")
        .run(JOURNAL_SCHEMA_VERSION, JOURNAL_SCHEMA_CHECKSUM, new Date().toISOString());
      this.#database.exec("COMMIT");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #replaceLegacySchema(): void {
    this.#database.exec(`
      DROP TABLE IF EXISTS compact_records;
      DROP TABLE IF EXISTS send_records;
      DROP TABLE IF EXISTS incarnations;
      DROP TABLE IF EXISTS operations;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS runtime_metadata;

      CREATE TABLE journal_agents(
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE journal_operations(
        operation_id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES journal_agents(agent_id),
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE journal_sends(
        send_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE journal_compacts(
        compact_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        data_json TEXT NOT NULL CHECK(json_valid(data_json))
      );
      CREATE TABLE journal_incarnations(
        incarnation_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        UNIQUE(agent_id, incarnation_id)
      );
      CREATE TABLE journal_epochs(
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        PRIMARY KEY(agent_id, epoch)
      );
      CREATE TABLE journal_raw_records(
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        raw_position INTEGER NOT NULL,
        incarnation_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        record_bytes BLOB NOT NULL,
        PRIMARY KEY(agent_id, raw_position),
        UNIQUE(agent_id, raw_position, epoch),
        FOREIGN KEY(agent_id, epoch) REFERENCES journal_epochs(agent_id, epoch),
        FOREIGN KEY(agent_id, incarnation_id)
          REFERENCES journal_incarnations(agent_id, incarnation_id)
      );
      CREATE TABLE journal_semantic_events(
        agent_id TEXT NOT NULL REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        event_position INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_epoch INTEGER NOT NULL,
        raw_position INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        PRIMARY KEY(agent_id, event_position),
        FOREIGN KEY(agent_id, event_epoch) REFERENCES journal_epochs(agent_id, epoch),
        FOREIGN KEY(agent_id, raw_position, event_epoch)
          REFERENCES journal_raw_records(agent_id, raw_position, epoch)
      );
      CREATE TABLE journal_projector_state(
        agent_id TEXT PRIMARY KEY REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        incarnation_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        FOREIGN KEY(agent_id, incarnation_id)
          REFERENCES journal_incarnations(agent_id, incarnation_id),
        FOREIGN KEY(agent_id, epoch) REFERENCES journal_epochs(agent_id, epoch)
      );
      CREATE TABLE journal_high_water(
        agent_id TEXT PRIMARY KEY REFERENCES journal_agents(agent_id) ON DELETE CASCADE,
        raw_position INTEGER NOT NULL,
        event_position INTEGER NOT NULL,
        idle_event_position INTEGER
      );
      CREATE TABLE journal_runtime_health(
        singleton_key INTEGER PRIMARY KEY CHECK(singleton_key = 1),
        storage_state TEXT NOT NULL CHECK(storage_state IN ('healthy', 'failed')),
        last_commit_at TEXT,
        clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
        started_at TEXT
      );
      INSERT INTO journal_runtime_health(
        singleton_key, storage_state, last_commit_at, clean_shutdown, started_at
      ) VALUES(1, 'healthy', NULL, 1, NULL);
      CREATE TABLE journal_destroy_receipts(
        operation_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        destroyed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status = 'destroyed')
      );
      CREATE INDEX journal_events_range
        ON journal_semantic_events(agent_id, event_position);
      CREATE INDEX journal_raw_range
        ON journal_raw_records(agent_id, raw_position);
    `);
  }

  #putOperationSync(operation: JournalOperation): void {
    this.#assertOpen();
    if (
      operation.agentId !== null &&
      this.#readJson<JournalAgent>(
        "SELECT data_json FROM journal_agents WHERE agent_id = ?",
        operation.agentId,
      ) === null
    ) {
      throw new Error("Operation targets an unknown agent generation");
    }
    const existing = this.#database
      .prepare("SELECT agent_id, data_json FROM journal_operations WHERE operation_id = ?")
      .get(operation.operationId) as
      | { readonly agent_id: string | null; readonly data_json: string }
      | undefined;
    if (existing !== undefined) {
      const prior = JSON.parse(existing.data_json) as JournalOperation;
      if (
        existing.agent_id !== null &&
        operation.agentId !== null &&
        existing.agent_id !== operation.agentId
      ) {
        throw new Error("Agent-owned record cannot change generations");
      }
      if (prior.method !== operation.method || prior.fingerprint !== operation.fingerprint) {
        throw new Error("Operation was already used with a different request");
      }
    }
    this.#database
      .prepare(
        `INSERT INTO journal_operations(operation_id, agent_id, data_json) VALUES(?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           agent_id=excluded.agent_id, data_json=excluded.data_json`,
      )
      .run(operation.operationId, operation.agentId, JSON.stringify(operation));
  }

  #putOwned(
    table: "journal_sends" | "journal_compacts" | "journal_incarnations",
    idColumn: "operation_id" | "send_id" | "compact_id" | "incarnation_id",
    id: string,
    agentId: AgentId,
    value: unknown,
  ): void {
    this.#assertOpen();
    const existing = this.#database
      .prepare(`SELECT agent_id FROM ${table} WHERE ${idColumn} = ?`)
      .get(id) as { readonly agent_id: string } | undefined;
    if (existing !== undefined && existing.agent_id !== agentId) {
      throw new Error("Agent-owned record cannot change generations");
    }
    this.#database
      .prepare(
        `INSERT INTO ${table}(${idColumn}, agent_id, data_json) VALUES(?, ?, ?)
         ON CONFLICT(${idColumn}) DO UPDATE SET data_json=excluded.data_json`,
      )
      .run(id, agentId, JSON.stringify(value));
  }

  #readJson<T>(sql: string, value: string): T | null {
    this.#assertOpen();
    const row = this.#database.prepare(sql).get(value) as JsonRow | undefined;
    return row === undefined ? null : (JSON.parse(row.data_json) as T);
  }

  #readJsonRows<T>(sql: string, ...values: readonly string[]): readonly T[] {
    this.#assertOpen();
    const rows = this.#database.prepare(sql).all(...values) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.data_json) as T);
  }

  #getHighWaterSync(agentId: AgentId): JournalHighWater | null {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT raw_position, event_position, idle_event_position
         FROM journal_high_water WHERE agent_id = ?`,
      )
      .get(agentId) as
      | {
          readonly raw_position: number;
          readonly event_position: number;
          readonly idle_event_position: number | null;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          rawPosition: row.raw_position,
          eventPosition: row.event_position,
          idleEventPosition: row.idle_event_position,
        };
  }

  #assertPositiveLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("Journal range limit must be positive");
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("pi-fleet journal store is closed");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function pragmaInteger(database: DatabaseSync, name: "auto_vacuum" | "freelist_count"): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite PRAGMA ${name} returned an invalid value`);
  }
  return value;
}

function autoVacuumMode(value: number): JournalMaintenanceResult["autoVacuumMode"] {
  if (value === 0) return "none";
  if (value === 1) return "full";
  if (value === 2) return "incremental";
  throw new Error("SQLite returned an unsupported auto_vacuum mode");
}
