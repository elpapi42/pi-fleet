import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
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

export class MemoryJournalStore implements JournalStore {
  readonly #agents = new Map<AgentId, JournalAgent>();
  readonly #agentIdsByName = new Map<string, AgentId>();
  readonly #operations = new Map<string, JournalOperation>();
  readonly #sends = new Map<string, JournalSend>();
  readonly #compacts = new Map<string, JournalCompact>();
  readonly #incarnations = new Map<string, JournalIncarnation>();
  readonly #rawRecords = new Map<AgentId, JournalAppend["records"]>();
  readonly #events = new Map<AgentId, readonly StoredSemanticEvent[]>();
  readonly #projectorStates = new Map<
    AgentId,
    {
      readonly incarnationId: IncarnationId;
      readonly epoch: ContinuityEpoch;
      readonly state: ProjectorState;
    }
  >();
  readonly #highWater = new Map<AgentId, JournalHighWater>();
  readonly #epochs = new Map<AgentId, readonly JournalEpoch[]>();
  readonly #destroyReceipts = new Map<string, JournalDestroyReceipt>();
  #lastCommitAt: string | null = null;
  #lastAppendDurationMs: number | null = null;
  #storageState: "healthy" | "failed" = "healthy";
  #maintenance: JournalMaintenanceResult = {
    state: "idle",
    lastCheckpointAt: null,
    busy: false,
    logFrames: 0,
    checkpointedFrames: 0,
    autoVacuumMode: "none",
    freelistPagesBefore: 0,
    freelistPagesAfter: 0,
    requestedReclaimPages: 0,
  };
  #closed = false;

  async createAgent(agent: JournalAgent): Promise<boolean> {
    this.#assertOpen();
    assertJournalAgentIdentity(agent);
    if (this.#agentIdsByName.has(agent.name) || this.#agents.has(agent.agentId)) return false;
    this.#agents.set(agent.agentId, structuredClone(agent));
    this.#agentIdsByName.set(agent.name, agent.agentId);
    return true;
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
    const existingOperation = this.#operations.get(operation.operationId);
    if (
      existingOperation !== undefined &&
      (existingOperation.method !== operation.method ||
        existingOperation.fingerprint !== operation.fingerprint ||
        (existingOperation.agentId !== null && existingOperation.agentId !== agent.agentId))
    ) {
      throw new Error("Operation was already used with a different request");
    }
    if (this.#agentIdsByName.has(agent.name) || this.#agents.has(agent.agentId)) return false;
    this.#agents.set(agent.agentId, structuredClone(agent));
    this.#agentIdsByName.set(agent.name, agent.agentId);
    this.#operations.set(operation.operationId, structuredClone(operation));
    return true;
  }

  async rollbackProvisionalCreate(
    agentId: AgentId,
    completedOperation: JournalOperation,
  ): Promise<JournalAgent | null> {
    this.#assertOpen();
    const existing = this.#agents.get(agentId);
    const pending = this.#operations.get(completedOperation.operationId);
    if (existing === undefined) return null;
    if (
      pending === undefined ||
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

    this.#deleteAgentOwnedState(agentId, existing.name);
    this.#operations.set(completedOperation.operationId, structuredClone(completedOperation));
    return structuredClone(existing);
  }

  async getAgentByName(name: string): Promise<JournalAgent | null> {
    const agentId = this.#agentIdsByName.get(name);
    return agentId === undefined ? null : this.#cloneAgent(this.#agents.get(agentId));
  }

  async getAgentById(agentId: AgentId): Promise<JournalAgent | null> {
    return this.#cloneAgent(this.#agents.get(agentId));
  }

  async listAgents(): Promise<readonly JournalAgent[]> {
    return [...this.#agents.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((agent) => structuredClone(agent));
  }

  async putAgent(agent: JournalAgent): Promise<void> {
    this.#assertOpen();
    assertJournalAgentIdentity(agent);
    const existing = this.#agents.get(agent.agentId);
    const owner = this.#agentIdsByName.get(agent.name);
    if (owner !== undefined && owner !== agent.agentId) {
      throw new Error(`Agent name ${agent.name} belongs to another generation`);
    }
    if (existing !== undefined && existing.name !== agent.name) {
      this.#agentIdsByName.delete(existing.name);
    }
    this.#agents.set(agent.agentId, structuredClone(agent));
    this.#agentIdsByName.set(agent.name, agent.agentId);
  }

  async putOperation(operation: JournalOperation): Promise<void> {
    this.#assertOpen();
    if (operation.agentId !== null) this.#requireAgent(operation.agentId);
    const existing = this.#operations.get(operation.operationId);
    if (
      existing?.agentId !== null &&
      existing?.agentId !== undefined &&
      operation.agentId !== null &&
      existing.agentId !== operation.agentId
    ) {
      throw new Error("Agent-owned record cannot change generations");
    }
    if (
      existing !== undefined &&
      (existing.method !== operation.method || existing.fingerprint !== operation.fingerprint)
    ) {
      throw new Error("Operation was already used with a different request");
    }
    this.#operations.set(operation.operationId, structuredClone(operation));
  }

  async getOperation(operationId: string): Promise<JournalOperation | null> {
    return this.#getOwned(this.#operations, operationId);
  }

  async listPendingOperations(): Promise<readonly JournalOperation[]> {
    return this.#listOwned(this.#operations, (operation) => operation.state === "pending");
  }

  async deleteOperation(operationId: string): Promise<void> {
    this.#assertOpen();
    this.#operations.delete(operationId);
  }

  async putSend(send: JournalSend): Promise<void> {
    this.#putOwned(this.#sends, send.sendId, send);
  }

  async getSend(sendId: string): Promise<JournalSend | null> {
    return this.#getOwned(this.#sends, sendId);
  }

  async nextSendOrdinal(agentId: AgentId): Promise<number> {
    this.#requireAgent(agentId);
    return (
      Math.max(
        0,
        ...[...this.#sends.values()]
          .filter((send) => send.agentId === agentId)
          .map((send) => send.ordinal),
      ) + 1
    );
  }

  async listNonterminalSends(): Promise<readonly JournalSend[]> {
    return this.#listOwned(
      this.#sends,
      (send) => send.state === "pending" || send.state === "dispatching",
    ).sort((left, right) => left.ordinal - right.ordinal);
  }

  async putCompact(compact: JournalCompact): Promise<void> {
    this.#putOwned(this.#compacts, compact.compactId, compact);
  }

  async getCompact(compactId: string): Promise<JournalCompact | null> {
    return this.#getOwned(this.#compacts, compactId);
  }

  async listNonterminalCompacts(): Promise<readonly JournalCompact[]> {
    return this.#listOwned(
      this.#compacts,
      (compact) => compact.state === "pending" || compact.state === "dispatching",
    );
  }

  async putIncarnation(incarnation: JournalIncarnation): Promise<void> {
    this.#putOwned(this.#incarnations, incarnation.incarnationId, incarnation);
  }

  async listActiveIncarnations(): Promise<readonly JournalIncarnation[]> {
    return this.#listOwned(this.#incarnations, (incarnation) =>
      ["starting", "live", "stopping", "cleanup_uncertain"].includes(incarnation.state),
    );
  }

  async putEpoch(epoch: JournalEpoch): Promise<void> {
    this.#requireAgent(epoch.agentId);
    const existing = this.#epochs.get(epoch.agentId) ?? [];
    const index = existing.findIndex((item) => item.epoch === epoch.epoch);
    const next = [...existing];
    if (index === -1) next.push(structuredClone(epoch));
    else next[index] = structuredClone(epoch);
    next.sort((left, right) => left.epoch - right.epoch);
    this.#epochs.set(epoch.agentId, next);
  }

  async getEpochs(agentId: AgentId): Promise<readonly JournalEpoch[]> {
    return structuredClone(this.#epochs.get(agentId) ?? []);
  }

  async beginIncarnation(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
    projectorState: ProjectorState,
  ): Promise<void> {
    this.#requireAgent(agentId);
    const incarnation = this.#incarnations.get(incarnationId);
    const epochRecord = (this.#epochs.get(agentId) ?? []).find((item) => item.epoch === epoch);
    if (incarnation?.agentId !== agentId) {
      throw new Error("Projector binding references an unknown incarnation");
    }
    if (epochRecord?.state !== "open") {
      throw new Error("Projector binding requires an open continuity epoch");
    }
    this.#projectorStates.set(agentId, {
      incarnationId,
      epoch,
      state: structuredClone(projectorState),
    });
  }

  async append(batch: JournalAppend): Promise<void> {
    const startedAt = performance.now();
    try {
      this.#requireAgent(batch.agentId);
      const current = this.#highWater.get(batch.agentId) ?? {
        rawPosition: 0,
        eventPosition: 0,
        idleEventPosition: null,
      };
      assertJournalAppend(
        batch,
        current,
        (this.#epochs.get(batch.agentId) ?? []).find((item) => item.epoch === batch.epoch) ?? null,
      );
      const projector = this.#projectorStates.get(batch.agentId);
      if (projector?.incarnationId !== batch.incarnationId || projector.epoch !== batch.epoch) {
        throw new Error("Journal append does not match the active projector incarnation");
      }

      const records = [
        ...(this.#rawRecords.get(batch.agentId) ?? []),
        ...batch.records.map((record) => ({ ...record, bytes: Buffer.from(record.bytes) })),
      ];
      const events = [
        ...(this.#events.get(batch.agentId) ?? []),
        ...batch.events.map((event) => structuredClone(event)),
      ];
      this.#rawRecords.set(batch.agentId, records);
      this.#events.set(batch.agentId, events);
      this.#projectorStates.set(batch.agentId, {
        incarnationId: batch.incarnationId,
        epoch: batch.epoch,
        state: structuredClone(batch.projectorState),
      });
      this.#highWater.set(batch.agentId, structuredClone(batch.highWater));
      this.#lastCommitAt = new Date().toISOString();
    } catch (error: unknown) {
      this.#storageState = "failed";
      throw error;
    } finally {
      this.#lastAppendDurationMs = Math.max(0, performance.now() - startedAt);
    }
  }

  async openReceive(agentId: AgentId): Promise<JournalReceiveSnapshot | null> {
    this.#assertOpen();
    const agent = this.#agents.get(agentId);
    if (agent === undefined) return null;
    return structuredClone({
      agent,
      epochs: this.#epochs.get(agentId) ?? [],
      highWater: this.#highWater.get(agentId) ?? {
        rawPosition: 0,
        eventPosition: 0,
        idleEventPosition: null,
      },
    });
  }

  async readEvents(range: JournalEventRange): Promise<readonly StoredSemanticEvent[]> {
    return structuredClone(boundedSemanticEvents(this.#events.get(range.agentId) ?? [], range));
  }

  async getProjectorState(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
  ): Promise<ProjectorState | null> {
    const binding = this.#projectorStates.get(agentId);
    if (binding === undefined) return null;
    if (binding.incarnationId !== incarnationId || binding.epoch !== epoch) {
      throw new Error("Projector state belongs to another incarnation or continuity epoch");
    }
    return structuredClone(binding.state);
  }

  async getHighWater(agentId: AgentId): Promise<JournalHighWater | null> {
    const highWater = this.#highWater.get(agentId);
    return highWater === undefined ? null : structuredClone(highWater);
  }

  async markIdle(agentId: AgentId, epoch: ContinuityEpoch): Promise<number> {
    this.#requireAgent(agentId);
    const epochRecord = (this.#epochs.get(agentId) ?? []).find((item) => item.epoch === epoch);
    if (epochRecord?.state !== "open") throw new Error("Idle marker requires an open epoch");
    const current = this.#highWater.get(agentId) ?? {
      rawPosition: 0,
      eventPosition: 0,
      idleEventPosition: null,
    };
    this.#highWater.set(agentId, {
      ...current,
      idleEventPosition: current.eventPosition,
    });
    this.#lastCommitAt = new Date().toISOString();
    return current.eventPosition;
  }

  async getRawRecords(
    agentId: AgentId,
    afterPosition: number,
    limit: number,
  ): Promise<JournalAppend["records"]> {
    this.#assertPositiveLimit(limit);
    return (this.#rawRecords.get(agentId) ?? [])
      .filter((record) => record.position > afterPosition)
      .slice(0, limit)
      .map((record) => ({ ...record, bytes: Buffer.from(record.bytes) }));
  }

  async destroyAgent(
    agentId: AgentId,
    receipt: JournalDestroyReceipt,
  ): Promise<JournalAgent | null> {
    this.#assertOpen();
    if (receipt.agentId !== agentId) throw new Error("Destroy receipt targets another agent");
    const priorReceipt = this.#destroyReceipts.get(receipt.operationId);
    if (priorReceipt !== undefined) {
      if (!sameJournalDestroyReceipt(priorReceipt, receipt)) {
        throw new Error("Destroy operation was already used");
      }
      return null;
    }
    const existing = this.#agents.get(agentId);
    if (existing === undefined) return null;

    this.#deleteAgentOwnedState(agentId, existing.name);
    this.#destroyReceipts.set(receipt.operationId, structuredClone(receipt));
    return structuredClone(existing);
  }

  async getDestroyReceipt(operationId: string): Promise<JournalDestroyReceipt | null> {
    const receipt = this.#destroyReceipts.get(operationId);
    return receipt === undefined ? null : structuredClone(receipt);
  }

  async maintain(reclaimPages = 0): Promise<JournalMaintenanceResult> {
    this.#assertOpen();
    if (!Number.isSafeInteger(reclaimPages) || reclaimPages < 0) {
      throw new Error("Journal reclaim page limit must be a non-negative integer");
    }
    this.#maintenance = {
      ...this.#maintenance,
      lastCheckpointAt: new Date().toISOString(),
      requestedReclaimPages: reclaimPages,
    };
    return structuredClone(this.#maintenance);
  }

  async getDiagnostics(): Promise<JournalStorageDiagnostics> {
    let rawRecordCount = 0;
    let rawBytes = 0;
    for (const records of this.#rawRecords.values()) {
      rawRecordCount += records.length;
      rawBytes += records.reduce((total, record) => total + record.bytes.byteLength, 0);
    }
    let semanticEventCount = 0;
    for (const events of this.#events.values()) semanticEventCount += events.length;
    let openProjectorActivities = 0;
    for (const binding of this.#projectorStates.values()) {
      openProjectorActivities += binding.state.openActivities.length;
    }
    let continuityGapCount = 0;
    for (const epochs of this.#epochs.values()) {
      continuityGapCount += epochs.filter(
        (epoch) => epoch.state === "closed" && epoch.reason === "observation_uncertain",
      ).length;
    }
    const retainedByAgent = [...this.#agents.keys()].map((agentId) => {
      const records = this.#rawRecords.get(agentId) ?? [];
      return {
        agentId,
        rawRecordCount: records.length,
        rawBytes: records.reduce((total, record) => total + record.bytes.byteLength, 0),
        semanticEventCount: (this.#events.get(agentId) ?? []).length,
      };
    });
    return {
      rawRecordCount,
      rawBytes,
      semanticEventCount,
      agentCount: this.#agents.size,
      retainedByAgent,
      openProjectorActivities,
      continuityGapCount,
      storageState: this.#storageState,
      lastCommitAt: this.#lastCommitAt,
      lastAppendDurationMs: this.#lastAppendDurationMs,
      maintenance: structuredClone(this.#maintenance),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #deleteAgentOwnedState(agentId: AgentId, name: string): void {
    this.#agents.delete(agentId);
    this.#agentIdsByName.delete(name);
    for (const [key, operation] of this.#operations) {
      if (operation.agentId === agentId) this.#operations.delete(key);
    }
    this.#deleteOwned(this.#sends, agentId);
    this.#deleteOwned(this.#compacts, agentId);
    this.#deleteOwned(this.#incarnations, agentId);
    this.#rawRecords.delete(agentId);
    this.#events.delete(agentId);
    this.#projectorStates.delete(agentId);
    this.#highWater.delete(agentId);
    this.#epochs.delete(agentId);
  }

  #cloneAgent(agent: JournalAgent | undefined): JournalAgent | null {
    return agent === undefined ? null : structuredClone(agent);
  }

  #requireAgent(agentId: AgentId): void {
    this.#assertOpen();
    if (!this.#agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`);
  }

  #putOwned<T extends { readonly agentId: AgentId }>(
    map: Map<string, T>,
    key: string,
    value: T,
  ): void {
    this.#requireAgent(value.agentId);
    const existing = map.get(key);
    if (existing !== undefined && existing.agentId !== value.agentId) {
      throw new Error("Agent-owned record cannot change generations");
    }
    map.set(key, structuredClone(value));
  }

  #getOwned<T>(map: Map<string, T>, key: string): T | null {
    const value = map.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  #listOwned<T>(map: Map<string, T>, predicate: (value: T) => boolean): T[] {
    return [...map.values()].filter(predicate).map((value) => structuredClone(value));
  }

  #deleteOwned<T extends { readonly agentId: AgentId }>(
    map: Map<string, T>,
    agentId: AgentId,
  ): void {
    for (const [key, value] of map) if (value.agentId === agentId) map.delete(key);
  }

  #assertPositiveLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("Journal range limit must be positive");
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("pi-fleet journal store is closed");
  }
}
