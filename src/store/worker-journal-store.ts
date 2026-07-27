import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
  RawRpcRecord,
} from "../runtime/semantic-events.js";
import { DEFAULT_RUNTIME_LIMITS } from "../shared/runtime-limits.js";
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
import { isJournalWorkerResponse, type JournalWorkerRequest } from "./journal-worker-protocol.js";

interface WorkerLike {
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(value: JournalWorkerRequest, transferList?: readonly ArrayBuffer[]): void;
  terminate(): Promise<number>;
}

export interface WorkerJournalStoreOptions {
  readonly worker?: WorkerLike;
  readonly workerUrl?: URL;
  readonly maxPending?: number;
  readonly checkpointCommitInterval?: number;
  readonly reclaimPagesPerPass?: number;
  readonly onHealthFailure?: (error: Error) => void;
}

interface QueuedCall {
  readonly request: JournalWorkerRequest;
  readonly transferList: readonly ArrayBuffer[];
  readonly priority: "write" | "read";
  readonly readerId?: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const WRITE_METHODS = new Set([
  "createAgent",
  "createAgentWithOperation",
  "rollbackProvisionalCreate",
  "putAgent",
  "putOperation",
  "deleteOperation",
  "putSend",
  "putCompact",
  "putIncarnation",
  "putEpoch",
  "beginIncarnation",
  "append",
  "markIdle",
  "destroyAgent",
  "maintain",
  "close",
]);

/** Dormant worker-backed journal store. It is not selected by runtime startup before Phase 4. */
export class WorkerJournalStore implements JournalStore {
  readonly #worker: WorkerLike;
  readonly #maxPending: number;
  readonly #onHealthFailure: ((error: Error) => void) | undefined;
  readonly #writes: QueuedCall[] = [];
  readonly #reads: QueuedCall[] = [];
  readonly #readerIds = new Set<string>();
  #active: QueuedCall | null = null;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #terminationPromise: Promise<number> | null = null;
  #failure: Error | null = null;

  constructor(path: string, options: WorkerJournalStoreOptions = {}) {
    this.#maxPending = options.maxPending ?? DEFAULT_RUNTIME_LIMITS.maxJournalPendingRecords;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending <= 0) {
      throw new Error("Journal worker maxPending must be a positive integer");
    }
    this.#onHealthFailure = options.onHealthFailure;
    this.#worker =
      options.worker ??
      new Worker(options.workerUrl ?? new URL("./journal-sqlite-worker.mjs", import.meta.url), {
        workerData: {
          path,
          checkpointCommitInterval:
            options.checkpointCommitInterval ??
            DEFAULT_RUNTIME_LIMITS.journalCheckpointCommitInterval,
          reclaimPagesPerPass:
            options.reclaimPagesPerPass ?? DEFAULT_RUNTIME_LIMITS.journalReclaimPagesPerPass,
        },
      });
    this.#worker.on("message", (value) => this.#handleResponse(value));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed) this.#fail(new Error(`Journal worker exited unexpectedly with ${code}`));
    });
  }

  createAgent(agent: JournalAgent): Promise<boolean> {
    return this.#call("createAgent", [agent]);
  }

  createAgentWithOperation(agent: JournalAgent, operation: JournalOperation): Promise<boolean> {
    return this.#call("createAgentWithOperation", [agent, operation]);
  }

  rollbackProvisionalCreate(
    agentId: AgentId,
    completedOperation: JournalOperation,
  ): Promise<JournalAgent | null> {
    return this.#call("rollbackProvisionalCreate", [agentId, completedOperation]);
  }

  getAgentByName(name: string): Promise<JournalAgent | null> {
    return this.#call("getAgentByName", [name]);
  }

  getAgentById(agentId: AgentId): Promise<JournalAgent | null> {
    return this.#call("getAgentById", [agentId]);
  }

  listAgents(): Promise<readonly JournalAgent[]> {
    return this.#call("listAgents", []);
  }

  async putAgent(agent: JournalAgent): Promise<void> {
    await this.#call("putAgent", [agent]);
  }

  async putOperation(operation: JournalOperation): Promise<void> {
    await this.#call("putOperation", [operation]);
  }

  getOperation(operationId: string): Promise<JournalOperation | null> {
    return this.#call("getOperation", [operationId]);
  }

  listPendingOperations(): Promise<readonly JournalOperation[]> {
    return this.#call("listPendingOperations", []);
  }

  async deleteOperation(operationId: string): Promise<void> {
    await this.#call("deleteOperation", [operationId]);
  }

  async putSend(send: JournalSend): Promise<void> {
    await this.#call("putSend", [send]);
  }

  getSend(sendId: string): Promise<JournalSend | null> {
    return this.#call("getSend", [sendId]);
  }

  nextSendOrdinal(agentId: AgentId): Promise<number> {
    return this.#call("nextSendOrdinal", [agentId]);
  }

  listNonterminalSends(): Promise<readonly JournalSend[]> {
    return this.#call("listNonterminalSends", []);
  }

  async putCompact(compact: JournalCompact): Promise<void> {
    await this.#call("putCompact", [compact]);
  }

  getCompact(compactId: string): Promise<JournalCompact | null> {
    return this.#call("getCompact", [compactId]);
  }

  listNonterminalCompacts(): Promise<readonly JournalCompact[]> {
    return this.#call("listNonterminalCompacts", []);
  }

  async putIncarnation(incarnation: JournalIncarnation): Promise<void> {
    await this.#call("putIncarnation", [incarnation]);
  }

  listActiveIncarnations(): Promise<readonly JournalIncarnation[]> {
    return this.#call("listActiveIncarnations", []);
  }

  async putEpoch(epoch: JournalEpoch): Promise<void> {
    await this.#call("putEpoch", [epoch]);
  }

  getEpochs(agentId: AgentId): Promise<readonly JournalEpoch[]> {
    return this.#call("getEpochs", [agentId]);
  }

  async beginIncarnation(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
    projectorState: ProjectorState,
  ): Promise<void> {
    await this.#call("beginIncarnation", [agentId, incarnationId, epoch, projectorState]);
  }

  async append(batch: JournalAppend): Promise<void> {
    const { args, transferList } = prepareAppend(batch);
    await this.#call("append", args, { transferList });
  }

  openReceive(agentId: AgentId): Promise<JournalReceiveSnapshot | null> {
    return this.#call("openReceive", [agentId]);
  }

  readEvents(range: JournalEventRange): Promise<readonly StoredSemanticEvent[]> {
    return this.readEventsForReader("default", range);
  }

  readEventsForReader(
    readerId: string,
    range: JournalEventRange,
  ): Promise<readonly StoredSemanticEvent[]> {
    if (this.#readerIds.has(readerId)) {
      return Promise.reject(new Error(`Reader ${readerId} already has an outstanding range read`));
    }
    this.#readerIds.add(readerId);
    return this.#call<readonly StoredSemanticEvent[]>("readEvents", [range], { readerId }).catch(
      (error: unknown) => {
        this.#readerIds.delete(readerId);
        throw error;
      },
    );
  }

  getProjectorState(
    agentId: AgentId,
    incarnationId: IncarnationId,
    epoch: ContinuityEpoch,
  ): Promise<ProjectorState | null> {
    return this.#call("getProjectorState", [agentId, incarnationId, epoch]);
  }

  getHighWater(agentId: AgentId): Promise<JournalHighWater | null> {
    return this.#call("getHighWater", [agentId]);
  }

  markIdle(agentId: AgentId, epoch: ContinuityEpoch): Promise<number> {
    return this.#call("markIdle", [agentId, epoch]);
  }

  getRawRecords(
    agentId: AgentId,
    afterPosition: number,
    limit: number,
  ): Promise<readonly RawRpcRecord[]> {
    return this.#call("getRawRecords", [agentId, afterPosition, limit]);
  }

  destroyAgent(agentId: AgentId, receipt: JournalDestroyReceipt): Promise<JournalAgent | null> {
    return this.#call("destroyAgent", [agentId, receipt]);
  }

  getDestroyReceipt(operationId: string): Promise<JournalDestroyReceipt | null> {
    return this.#call("getDestroyReceipt", [operationId]);
  }

  maintain(reclaimPages?: number): Promise<JournalMaintenanceResult> {
    return this.#call("maintain", reclaimPages === undefined ? [] : [reclaimPages]);
  }

  getDiagnostics(): Promise<JournalStorageDiagnostics> {
    return this.#call("getDiagnostics", []);
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#closed) return Promise.resolve();

    this.#closing = true;
    this.#rejectQueued(new Error("pi-fleet journal store is closing"));
    this.#closePromise = (async () => {
      let closeError: unknown = null;
      try {
        if (this.#failure === null) await this.#enqueueClose();
      } catch (error: unknown) {
        closeError = error;
      }

      this.#closed = true;
      try {
        await this.#terminateWorker();
      } catch (error: unknown) {
        if (closeError === null) closeError = error;
      }
      if (closeError !== null) throw closeError;
    })();
    return this.#closePromise;
  }

  #call<T>(
    method: string,
    args: readonly unknown[],
    options: { readonly transferList?: readonly ArrayBuffer[]; readonly readerId?: string } = {},
  ): Promise<T> {
    if (this.#closing || this.#closed) {
      if (options.readerId !== undefined) this.#readerIds.delete(options.readerId);
      return Promise.reject(
        new Error(`pi-fleet journal store is ${this.#closed ? "closed" : "closing"}`),
      );
    }
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#pendingCount() >= this.#maxPending) {
      if (options.readerId !== undefined) this.#readerIds.delete(options.readerId);
      return Promise.reject(new Error("Journal worker pending capacity exceeded"));
    }
    return new Promise<T>((resolve, reject) => {
      const call: QueuedCall = {
        request: { id: randomUUID(), method, args },
        transferList: options.transferList ?? [],
        priority: WRITE_METHODS.has(method) ? "write" : "read",
        ...(options.readerId === undefined ? {} : { readerId: options.readerId }),
        resolve: (value) => resolve(value as T),
        reject,
      };
      (call.priority === "write" ? this.#writes : this.#reads).push(call);
      this.#pump();
    });
  }

  #enqueueClose(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#writes.unshift({
        request: { id: randomUUID(), method: "close", args: [] },
        transferList: [],
        priority: "write",
        resolve: () => resolve(),
        reject,
      });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#active !== null || this.#failure !== null || this.#closed) return;
    const next = this.#writes.shift() ?? this.#reads.shift();
    if (next === undefined) return;
    this.#active = next;
    try {
      this.#worker.postMessage(next.request, next.transferList);
    } catch (error: unknown) {
      this.#fail(error instanceof Error ? error : new Error("Journal worker request failed"));
    }
  }

  #handleResponse(value: unknown): void {
    if (!isJournalWorkerResponse(value)) {
      this.#fail(new Error("Journal worker returned a malformed response"));
      return;
    }
    const active = this.#active;
    if (active === null || active.request.id !== value.id) {
      this.#fail(new Error("Journal worker returned an unexpected response"));
      return;
    }
    if (!value.ok && active.priority === "write") {
      this.#fail(new Error(value.error ?? "Journal worker durability write failed"));
      return;
    }
    this.#active = null;
    if (active.readerId !== undefined) this.#readerIds.delete(active.readerId);
    if (value.ok) active.resolve(value.value);
    else active.reject(new Error(value.error ?? "Journal worker failed"));
    this.#pump();
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#onHealthFailure?.(error);
    void this.#terminateWorker();
    const calls = [this.#active, ...this.#writes, ...this.#reads].filter(
      (call): call is QueuedCall => call !== null,
    );
    this.#active = null;
    this.#writes.length = 0;
    this.#reads.length = 0;
    this.#readerIds.clear();
    for (const call of calls) call.reject(error);
  }

  #terminateWorker(): Promise<number> {
    this.#terminationPromise ??= this.#worker.terminate();
    return this.#terminationPromise;
  }

  #rejectQueued(error: Error): void {
    const queued = [...this.#writes, ...this.#reads];
    this.#writes.length = 0;
    this.#reads.length = 0;
    for (const call of queued) {
      if (call.readerId !== undefined) this.#readerIds.delete(call.readerId);
      call.reject(error);
    }
  }

  #pendingCount(): number {
    return (this.#active === null ? 0 : 1) + this.#writes.length + this.#reads.length;
  }
}

function prepareAppend(batch: JournalAppend): {
  readonly args: readonly unknown[];
  readonly transferList: readonly ArrayBuffer[];
} {
  const transferList: ArrayBuffer[] = [];
  const records = batch.records.map((record) => {
    const bytes = Uint8Array.from(record.bytes);
    transferList.push(bytes.buffer);
    return { ...record, bytes };
  });
  return { args: [{ ...batch, records }], transferList };
}
