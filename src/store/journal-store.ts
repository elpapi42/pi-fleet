import type { AgentSummary } from "../client/fleet-client.js";
import type { AgentLaunchProfile } from "../pi/launch-profile.js";
import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
  RawRpcRecord,
  SemanticEvent,
} from "../runtime/semantic-events.js";

export interface JournalAgent {
  readonly agentId: AgentId;
  readonly name: string;
  readonly summary: AgentSummary;
  readonly launch: AgentLaunchProfile;
}

export interface JournalOperation {
  readonly operationId: string;
  readonly agentId: AgentId | null;
  readonly targetName: string;
  readonly method: "create" | "send" | "destroy" | "compact";
  readonly fingerprint: string;
  readonly state: "pending" | "completed";
  readonly result: unknown | null;
  /** Retained only while pending so proven-undispatched work can resume. */
  readonly request?: unknown;
}

export interface JournalSend {
  readonly sendId: string;
  readonly agentId: AgentId;
  readonly ordinal: number;
  readonly message: string;
  readonly delivery: "steer" | "followUp";
  readonly state: "pending" | "dispatching" | "acknowledged" | "failed" | "uncertain";
  readonly acceptedAt: string;
}

export interface JournalCompact {
  readonly compactId: string;
  readonly agentId: AgentId;
  readonly state: "pending" | "dispatching" | "completed" | "failed" | "uncertain";
  readonly requestedAt: string;
  readonly result?: {
    readonly tokensBefore: number;
    readonly estimatedTokensAfter?: number;
  };
  readonly error?: unknown;
}

export interface JournalIncarnation {
  readonly incarnationId: IncarnationId;
  readonly agentId: AgentId;
  readonly pid: number | null;
  readonly state: "starting" | "live" | "stopping" | "cleanup_uncertain" | "gone";
}

export interface JournalHighWater {
  readonly rawPosition: number;
  readonly eventPosition: number;
  readonly idleEventPosition: number | null;
}

export interface JournalEpoch {
  readonly agentId: AgentId;
  readonly epoch: ContinuityEpoch;
  readonly state: "open" | "closed";
  readonly lastSafeEventPosition: number;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly reason?: "observation_uncertain";
}

export interface StoredSemanticEvent {
  readonly agentId: AgentId;
  readonly position: number;
  readonly event: SemanticEvent;
}

export interface JournalAppend {
  readonly agentId: AgentId;
  readonly incarnationId: IncarnationId;
  readonly epoch: ContinuityEpoch;
  readonly records: readonly RawRpcRecord[];
  readonly events: readonly StoredSemanticEvent[];
  readonly projectorState: ProjectorState;
  readonly highWater: JournalHighWater;
}

export interface JournalEventRange {
  readonly agentId: AgentId;
  readonly epoch: ContinuityEpoch;
  readonly afterPosition: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
}

export interface JournalReceiveSnapshot {
  readonly agent: JournalAgent;
  readonly epochs: readonly JournalEpoch[];
  readonly highWater: JournalHighWater;
}

export interface JournalDestroyReceipt {
  readonly operationId: string;
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly fingerprint: string;
  readonly destroyedAt: string;
  readonly status: "destroyed";
}

export interface JournalAgentStorageDiagnostics {
  readonly agentId: AgentId;
  readonly rawRecordCount: number;
  readonly rawBytes: number;
  readonly semanticEventCount: number;
}

export interface JournalMaintenanceResult {
  readonly state: "idle" | "running" | "failed";
  readonly lastCheckpointAt: string | null;
  readonly busy: boolean;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
  readonly autoVacuumMode: "none" | "full" | "incremental";
  readonly freelistPagesBefore: number;
  readonly freelistPagesAfter: number;
  readonly requestedReclaimPages: number;
}

export interface JournalStorageDiagnostics {
  readonly rawRecordCount: number;
  readonly rawBytes: number;
  readonly semanticEventCount: number;
  readonly agentCount: number;
  readonly retainedByAgent: readonly JournalAgentStorageDiagnostics[];
  readonly openProjectorActivities: number;
  readonly continuityGapCount: number;
  readonly storageState: "healthy" | "failed";
  readonly lastCommitAt: string | null;
  readonly lastAppendDurationMs: number | null;
  readonly maintenance: JournalMaintenanceResult;
}

export interface JournalStore {
  createAgent(agent: JournalAgent): Promise<boolean>;
  createAgentWithOperation(agent: JournalAgent, operation: JournalOperation): Promise<boolean>;
  rollbackProvisionalCreate(
    agentId: AgentId,
    completedOperation: JournalOperation,
  ): Promise<JournalAgent | null>;
  getAgentByName(name: string): Promise<JournalAgent | null>;
  getAgentById(agentId: AgentId): Promise<JournalAgent | null>;
  listAgents(): Promise<readonly JournalAgent[]>;
  putAgent(agent: JournalAgent): Promise<void>;

  putOperation(operation: JournalOperation): Promise<void>;
  getOperation(operationId: string): Promise<JournalOperation | null>;
  listPendingOperations(): Promise<readonly JournalOperation[]>;
  deleteOperation(operationId: string): Promise<void>;
  putSend(send: JournalSend): Promise<void>;
  getSend(sendId: string): Promise<JournalSend | null>;
  nextSendOrdinal(agentId: AgentId): Promise<number>;
  listNonterminalSends(): Promise<readonly JournalSend[]>;
  putCompact(compact: JournalCompact): Promise<void>;
  getCompact(compactId: string): Promise<JournalCompact | null>;
  listNonterminalCompacts(): Promise<readonly JournalCompact[]>;
  putIncarnation(incarnation: JournalIncarnation): Promise<void>;
  listActiveIncarnations(): Promise<readonly JournalIncarnation[]>;

  putEpoch(epoch: JournalEpoch): Promise<void>;
  beginIncarnation(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
    projectorState: ProjectorState,
  ): Promise<void>;
  getEpochs(agentId: AgentId): Promise<readonly JournalEpoch[]>;
  append(batch: JournalAppend): Promise<void>;
  openReceive(agentId: AgentId): Promise<JournalReceiveSnapshot | null>;
  readEvents(range: JournalEventRange): Promise<readonly StoredSemanticEvent[]>;
  getProjectorState(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
  ): Promise<ProjectorState | null>;
  getHighWater(agentId: AgentId): Promise<JournalHighWater | null>;
  markIdle(agentId: AgentId, epoch: ContinuityEpoch): Promise<number>;
  getRawRecords(
    agentId: AgentId,
    afterPosition: number,
    limit: number,
  ): Promise<readonly RawRpcRecord[]>;

  destroyAgent(agentId: AgentId, receipt: JournalDestroyReceipt): Promise<JournalAgent | null>;
  getDestroyReceipt(operationId: string): Promise<JournalDestroyReceipt | null>;
  maintain(reclaimPages?: number): Promise<JournalMaintenanceResult>;
  getDiagnostics(): Promise<JournalStorageDiagnostics>;
  close(): Promise<void>;
}

export function boundedSemanticEvents(
  events: Iterable<StoredSemanticEvent>,
  range: JournalEventRange,
): readonly StoredSemanticEvent[] {
  if (!Number.isSafeInteger(range.limit) || range.limit <= 0) {
    throw new Error("Journal event range limit must be positive");
  }
  if (!Number.isSafeInteger(range.maxBytes) || range.maxBytes <= 0) {
    throw new Error("Journal event range byte limit must be positive");
  }
  if (!Number.isSafeInteger(range.maxEventBytes) || range.maxEventBytes <= 0) {
    throw new Error("Journal semantic event limit must be positive");
  }

  const selected: StoredSemanticEvent[] = [];
  let selectedBytes = 0;
  for (const stored of events) {
    if (stored.agentId !== range.agentId || stored.event.epoch !== range.epoch) continue;
    if (stored.position <= range.afterPosition) continue;
    const bytes = Buffer.byteLength(JSON.stringify(stored));
    if (bytes > range.maxEventBytes) throw new Error("Semantic event exceeds storage read limit");
    if (selected.length > 0 && selectedBytes + bytes > range.maxBytes) break;
    selected.push(stored);
    selectedBytes += bytes;
    if (selected.length >= range.limit || selectedBytes >= range.maxBytes) break;
  }
  return selected;
}

export function sameJournalDestroyReceipt(
  left: JournalDestroyReceipt,
  right: JournalDestroyReceipt,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.agentId === right.agentId &&
    left.agentName === right.agentName &&
    left.fingerprint === right.fingerprint &&
    left.destroyedAt === right.destroyedAt &&
    left.status === right.status
  );
}

export function assertJournalAgentIdentity(agent: JournalAgent): void {
  if (agent.summary.id !== agent.agentId || agent.summary.name !== agent.name) {
    throw new Error("Journal agent identity does not match its summary");
  }
}

export function assertJournalAppend(
  batch: JournalAppend,
  current: JournalHighWater,
  epoch: JournalEpoch | null,
): void {
  if (epoch === null) throw new Error("Journal append references an unknown continuity epoch");
  if (epoch.state !== "open")
    throw new Error("Journal append references a closed continuity epoch");
  let rawPosition = current.rawPosition;
  const appendedRawPositions = new Set<number>();
  for (const record of batch.records) {
    if (record.agentId !== batch.agentId) throw new Error("Raw record targets another agent");
    if (record.incarnationId !== batch.incarnationId) {
      throw new Error("Raw record targets another incarnation");
    }
    if (record.position !== ++rawPosition) throw new Error("Raw record position is not contiguous");
    appendedRawPositions.add(record.position);
  }
  let eventPosition = current.eventPosition;
  for (const stored of batch.events) {
    if (stored.agentId !== batch.agentId || stored.event.agentId !== batch.agentId) {
      throw new Error("Semantic event targets another agent");
    }
    if (stored.event.epoch !== batch.epoch) throw new Error("Semantic event epoch mismatch");
    if (stored.position !== ++eventPosition) {
      throw new Error("Semantic event position is not contiguous");
    }
    if (!appendedRawPositions.has(stored.event.sourceRawPosition)) {
      throw new Error("Semantic event must reference a raw record from the same append and epoch");
    }
  }
  if (
    batch.highWater.rawPosition !== rawPosition ||
    batch.highWater.eventPosition !== eventPosition
  ) {
    throw new Error("Journal high-water position does not match the append");
  }
  if (
    batch.highWater.idleEventPosition !== null &&
    batch.highWater.idleEventPosition > eventPosition
  ) {
    throw new Error("Idle high-water position exceeds committed events");
  }
}
