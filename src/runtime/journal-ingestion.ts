import type { AgentId } from "./semantic-events.js";

export interface JournalIngressRecord<T> {
  readonly agentId: AgentId;
  readonly bytes: Buffer;
  readonly value: T;
  readonly batchKey?: string;
}

export interface JournalIngestionLimits {
  readonly maxPendingRecords: number;
  readonly maxPendingBytes: number;
  readonly maxPendingBytesPerAgent: number;
  readonly maxBatchRecords: number;
  readonly maxBatchBytes: number;
  readonly maxBatchAgeMs: number;
}

export interface JournalIngestionOptions<T> {
  readonly limits: JournalIngestionLimits;
  readonly commit: (records: readonly JournalIngressRecord<T>[]) => Promise<void>;
  readonly pauseAgent?: (agentId: AgentId) => void;
  readonly resumeAgent?: (agentId: AgentId) => void;
  readonly failAgent?: (agentId: AgentId, error: Error) => void;
  readonly now?: () => number;
}

interface PendingRecord<T> {
  readonly record: JournalIngressRecord<T>;
  readonly enqueuedAt: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Dormant bounded admission and fair batching for durability writes. */
export class JournalIngestionScheduler<T> {
  readonly #limits: JournalIngestionLimits;
  readonly #commit: JournalIngestionOptions<T>["commit"];
  readonly #pauseAgent: NonNullable<JournalIngestionOptions<T>["pauseAgent"]>;
  readonly #resumeAgent: NonNullable<JournalIngestionOptions<T>["resumeAgent"]>;
  readonly #failAgentCallback: NonNullable<JournalIngestionOptions<T>["failAgent"]>;
  readonly #now: () => number;
  readonly #queues = new Map<AgentId, PendingRecord<T>[]>();
  readonly #pendingBytesByAgent = new Map<AgentId, number>();
  readonly #pausedAgents = new Set<AgentId>();
  readonly #failedAgents = new Map<AgentId, Error>();
  #pendingRecords = 0;
  #pendingBytes = 0;
  #roundRobinOffset = 0;
  #timer: NodeJS.Timeout | null = null;
  #flushPromise: Promise<void> | null = null;
  #activeOldestEnqueuedAt: number | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;

  constructor(options: JournalIngestionOptions<T>) {
    validateLimits(options.limits);
    this.#limits = options.limits;
    this.#commit = options.commit;
    this.#pauseAgent = options.pauseAgent ?? (() => undefined);
    this.#resumeAgent = options.resumeAgent ?? (() => undefined);
    this.#failAgentCallback = options.failAgent ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  get pendingRecords(): number {
    return this.#pendingRecords;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get oldestPendingAgeMs(): number {
    let oldest = this.#activeOldestEnqueuedAt ?? Number.POSITIVE_INFINITY;
    for (const queue of this.#queues.values()) {
      for (const pending of queue) oldest = Math.min(oldest, pending.enqueuedAt);
    }
    return oldest === Number.POSITIVE_INFINITY ? 0 : Math.max(0, this.#now() - oldest);
  }

  get pausedAgentCount(): number {
    return this.#pausedAgents.size;
  }

  get failedAgentCount(): number {
    return this.#failedAgents.size;
  }

  enqueue(record: JournalIngressRecord<T>): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Journal ingestion is closed"));
    const priorFailure = this.#failedAgents.get(record.agentId);
    if (priorFailure !== undefined) return Promise.reject(priorFailure);

    const ownedRecord = { ...record, bytes: Buffer.from(record.bytes) };
    const agentBytes = this.#pendingBytesByAgent.get(record.agentId) ?? 0;
    if (
      ownedRecord.bytes.length > this.#limits.maxPendingBytesPerAgent ||
      agentBytes + ownedRecord.bytes.length > this.#limits.maxPendingBytesPerAgent ||
      this.#pendingRecords + 1 > this.#limits.maxPendingRecords ||
      this.#pendingBytes + ownedRecord.bytes.length > this.#limits.maxPendingBytes
    ) {
      const error = new Error("Journal ingestion capacity exceeded");
      this.#failAgent(record.agentId, error);
      return Promise.reject(error);
    }

    const completion = new Promise<void>((resolve, reject) => {
      const queue = this.#queues.get(record.agentId) ?? [];
      queue.push({ record: ownedRecord, enqueuedAt: this.#now(), resolve, reject });
      this.#queues.set(record.agentId, queue);
    });
    this.#pendingRecords += 1;
    this.#pendingBytes += ownedRecord.bytes.length;
    const nextAgentBytes = agentBytes + ownedRecord.bytes.length;
    this.#pendingBytesByAgent.set(record.agentId, nextAgentBytes);
    this.#refreshPauses();
    this.#scheduleFlush();
    return completion;
  }

  async drain(): Promise<void> {
    this.#clearTimer();
    while (this.#pendingRecords > 0) {
      await this.#flush();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.drain();
    return this.#closePromise;
  }

  #scheduleFlush(): void {
    if (this.#flushPromise !== null) return;
    if (
      this.#pendingRecords >= this.#limits.maxBatchRecords ||
      this.#pendingBytes >= this.#limits.maxBatchBytes
    ) {
      queueMicrotask(() => void this.#flush());
      return;
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.#flush();
      }, this.#limits.maxBatchAgeMs);
    }
  }

  #flush(): Promise<void> {
    if (this.#flushPromise !== null) return this.#flushPromise;
    this.#clearTimer();
    const batch = this.#takeBatch();
    if (batch.length === 0) return Promise.resolve();
    this.#activeOldestEnqueuedAt = Math.min(...batch.map((pending) => pending.enqueuedAt));

    const flushing = Promise.resolve()
      .then(() => this.#commit(batch.map((pending) => pending.record)))
      .then(() => {
        for (const pending of batch) this.#settle(pending, null);
      })
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const agents = new Set(batch.map((pending) => pending.record.agentId));
        for (const pending of batch) this.#settle(pending, error, false);
        for (const agentId of agents) this.#failAgent(agentId, error);
      })
      .finally(() => {
        this.#flushPromise = null;
        this.#activeOldestEnqueuedAt = null;
        if (this.#pendingRecords > 0) queueMicrotask(() => void this.#flush());
      });
    this.#flushPromise = flushing;
    return flushing;
  }

  #takeBatch(): PendingRecord<T>[] {
    const agentIds = [...this.#queues.keys()].filter(
      (agentId) => (this.#queues.get(agentId)?.length ?? 0) > 0,
    );
    if (agentIds.length === 0) return [];

    const index = this.#roundRobinOffset % agentIds.length;
    const agentId = agentIds[index] as AgentId;
    this.#roundRobinOffset = (index + 1) % agentIds.length;
    const queue = this.#queues.get(agentId) as PendingRecord<T>[];
    const batchKey = queue[0]?.record.batchKey ?? agentId;
    const batch: PendingRecord<T>[] = [];
    let batchBytes = 0;
    while (batch.length < this.#limits.maxBatchRecords && queue.length > 0) {
      const next = queue[0] as PendingRecord<T>;
      if ((next.record.batchKey ?? agentId) !== batchKey) break;
      if (batch.length > 0 && batchBytes + next.record.bytes.length > this.#limits.maxBatchBytes) {
        break;
      }
      queue.shift();
      batch.push(next);
      batchBytes += next.record.bytes.length;
    }
    return batch;
  }

  #settle(pending: PendingRecord<T>, error: Error | null, refreshPauses = true): void {
    const { agentId, bytes } = pending.record;
    this.#pendingRecords -= 1;
    this.#pendingBytes -= bytes.length;
    const agentBytes = (this.#pendingBytesByAgent.get(agentId) ?? bytes.length) - bytes.length;
    if (agentBytes <= 0) this.#pendingBytesByAgent.delete(agentId);
    else this.#pendingBytesByAgent.set(agentId, agentBytes);

    if (refreshPauses) this.#refreshPauses();
    if (error === null) pending.resolve();
    else pending.reject(error);
  }

  #failAgent(agentId: AgentId, error: Error): void {
    if (this.#failedAgents.has(agentId)) return;
    this.#failedAgents.set(agentId, error);
    const queued = this.#queues.get(agentId) ?? [];
    this.#queues.delete(agentId);
    for (const pending of queued) this.#settle(pending, error);
    this.#refreshPauses();
    this.#failAgentCallback(agentId, error);
  }

  #refreshPauses(): void {
    const globalHigh =
      this.#pendingBytes >= Math.max(1, Math.floor(this.#limits.maxPendingBytes * 0.75)) ||
      this.#pendingRecords >= Math.max(1, Math.floor(this.#limits.maxPendingRecords * 0.75));
    const globalLow =
      this.#pendingBytes <= Math.floor(this.#limits.maxPendingBytes * 0.5) &&
      this.#pendingRecords <= Math.floor(this.#limits.maxPendingRecords * 0.5);
    const candidates = new Set([...this.#pendingBytesByAgent.keys(), ...this.#pausedAgents]);
    for (const agentId of candidates) {
      if (this.#failedAgents.has(agentId)) {
        this.#pausedAgents.delete(agentId);
        continue;
      }
      const agentBytes = this.#pendingBytesByAgent.get(agentId) ?? 0;
      const agentHigh =
        agentBytes >= Math.max(1, Math.floor(this.#limits.maxPendingBytesPerAgent * 0.75));
      const agentLow = agentBytes <= Math.floor(this.#limits.maxPendingBytesPerAgent * 0.5);
      if ((globalHigh || agentHigh) && !this.#pausedAgents.has(agentId)) {
        this.#pausedAgents.add(agentId);
        this.#pauseAgent(agentId);
      } else if (globalLow && agentLow && this.#pausedAgents.delete(agentId)) {
        this.#resumeAgent(agentId);
      }
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

function validateLimits(limits: JournalIngestionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
}
