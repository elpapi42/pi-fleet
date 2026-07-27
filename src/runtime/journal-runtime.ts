import type { ReceiveCursorCodec, ReceiveStart } from "../client/agent-target.js";
import { RpcRecordFramer } from "../pi/rpc-record-framer.js";
import type { RuntimeLimits } from "../shared/runtime-limits.js";
import type {
  JournalAppend,
  JournalHighWater,
  JournalStore,
  StoredSemanticEvent,
} from "../store/journal-store.js";
import { JournalIngestionScheduler, type JournalIngestionLimits } from "./journal-ingestion.js";
import { initialProjectorState, projectLifecycleRecord } from "./lifecycle-projector.js";
import {
  collectRuntimeJournalDiagnostics,
  type RuntimeJournalDiagnostics,
} from "./runtime-diagnostics.js";
import {
  ReceivePager,
  type ReceivePagerLimits,
  type ReceiveStream,
  type ReceiveWakeup,
} from "./receive-pager.js";
import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  RawRpcRecord,
  ReceiveCursor,
} from "./semantic-events.js";

interface JournalCandidate {
  readonly agentId: AgentId;
  readonly incarnationId: IncarnationId;
  readonly epoch: ContinuityEpoch;
  readonly observedAt: string;
  readonly bytes: Buffer;
}

export interface JournalRuntimeCompositionOptions {
  readonly store: JournalStore;
  readonly limits: RuntimeLimits;
  readonly cursors: ReceiveCursorCodec;
  readonly wakeup: ReceiveWakeup;
  readonly now?: () => string;
  readonly pauseAgent?: (agentId: AgentId) => void;
  readonly resumeAgent?: (agentId: AgentId) => void;
  readonly failAgent?: (agentId: AgentId, error: Error) => void;
  readonly notifyEvents?: (agentId: AgentId, eventPosition: number) => void;
}

export interface JournalIncarnationSink {
  /** Chunk-oriented compatibility seam for dormant/local composition tests. */
  push(chunk: Buffer): Promise<void>;
  /** Selected production seam: accepts one exact complete LF-terminated record. */
  pushRecord(record: Buffer): Promise<void>;
  finish(): Buffer | null;
}

/** Dormant composition root for exact stdout persistence and semantic replay. */
export class JournalRuntimeComposition {
  readonly receive: ReceivePager;
  readonly ingestion: JournalIngestionScheduler<JournalCandidate>;
  readonly #framers = new Map<IncarnationId, RpcRecordFramer>();
  readonly #activeIncarnationsByAgent = new Map<
    AgentId,
    { readonly incarnationId: IncarnationId; readonly epoch: ContinuityEpoch }
  >();
  readonly #store: JournalStore;
  readonly #limits: RuntimeLimits;
  readonly #now: () => string;
  readonly #notifyEvents: NonNullable<JournalRuntimeCompositionOptions["notifyEvents"]>;
  readonly #cursors: ReceiveCursorCodec;
  #activeReceiveStreams = 0;
  #activeReplayReads = 0;

  constructor(options: JournalRuntimeCompositionOptions) {
    this.#store = options.store;
    this.#limits = options.limits;
    this.#now = options.now ?? (() => new Date().toISOString());
    // A wakeup that cannot be notified would leave live receive streams blocked
    // forever, so default to notifying the injected wakeup itself.
    this.#notifyEvents = options.notifyEvents ?? defaultNotifyEvents(options.wakeup);
    this.#cursors = options.cursors;
    this.ingestion = new JournalIngestionScheduler({
      limits: journalIngestionLimitsFromRuntime(options.limits),
      commit: (records) => this.#commit(records.map((record) => record.value)),
      ...(options.pauseAgent === undefined ? {} : { pauseAgent: options.pauseAgent }),
      ...(options.resumeAgent === undefined ? {} : { resumeAgent: options.resumeAgent }),
      ...(options.failAgent === undefined ? {} : { failAgent: options.failAgent }),
    });
    this.receive = new ReceivePager(
      options.store,
      options.cursors,
      options.wakeup,
      receivePagerLimitsFromRuntime(options.limits),
      {
        onReadStart: () => {
          this.#activeReplayReads += 1;
        },
        onReadEnd: () => {
          this.#activeReplayReads -= 1;
        },
      },
    );
  }

  async openIncarnation(options: {
    readonly agentId: AgentId;
    readonly incarnationId: IncarnationId;
    readonly epoch: ContinuityEpoch;
  }): Promise<JournalIncarnationSink> {
    if (this.#framers.has(options.incarnationId)) {
      throw new Error("Journal incarnation sink already exists");
    }
    await this.#store.beginIncarnation(
      options.agentId,
      options.incarnationId,
      options.epoch,
      initialProjectorState(),
    );
    const framer = new RpcRecordFramer(this.#limits.maxJournalPartialRecordBytes);
    this.#framers.set(options.incarnationId, framer);
    this.#activeIncarnationsByAgent.set(options.agentId, {
      incarnationId: options.incarnationId,
      epoch: options.epoch,
    });
    let finished = false;
    const pushRecord = async (record: Buffer): Promise<void> => {
      if (finished) throw new Error("Journal incarnation sink is finished");
      if (record.length === 0 || record.at(-1) !== 0x0a) {
        throw new Error("Journal incarnation sink requires a complete LF-terminated record");
      }
      const bytes = Buffer.from(record);
      await this.ingestion.enqueue({
        agentId: options.agentId,
        batchKey: `${options.agentId}:${options.epoch}:${options.incarnationId}`,
        bytes,
        value: {
          ...options,
          observedAt: this.#now(),
          bytes,
        },
      });
    };
    return {
      push: async (chunk) => {
        await Promise.all(framer.push(chunk).map((record) => pushRecord(record)));
      },
      pushRecord,
      finish: () => {
        if (finished) throw new Error("Journal incarnation sink is finished");
        finished = true;
        this.#framers.delete(options.incarnationId);
        const active = this.#activeIncarnationsByAgent.get(options.agentId);
        if (active?.incarnationId === options.incarnationId) {
          this.#activeIncarnationsByAgent.delete(options.agentId);
        }
        return framer.finish();
      },
    };
  }

  async openReceive(
    agentId: AgentId,
    start: ReceiveStart,
    signal: AbortSignal,
  ): Promise<ReceiveStream> {
    if (this.#activeReceiveStreams >= this.#limits.maxReceiveStreams) {
      const error = new Error("Receive stream capacity exceeded") as Error & { code: string };
      error.code = "receive_resource_exhausted";
      throw error;
    }
    const stream = await this.receive.open(agentId, start, signal);
    this.#activeReceiveStreams += 1;
    let released = false;
    let iteratorCreated = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", release);
      this.#activeReceiveStreams -= 1;
    };
    signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) release();
    return {
      cursor: stream.cursor,
      [Symbol.asyncIterator]: () => {
        if (iteratorCreated) throw new Error("Receive stream can only be iterated once");
        iteratorCreated = true;
        const iterator = stream[Symbol.asyncIterator]();
        return {
          next: async () => {
            try {
              const result = await iterator.next();
              if (result.done) release();
              return result;
            } catch (error: unknown) {
              release();
              throw error;
            }
          },
          return: async () => {
            release();
            return iterator.return?.() ?? { done: true, value: undefined };
          },
          throw: async (error?: unknown) => {
            release();
            if (iterator.throw !== undefined) return iterator.throw(error);
            throw error;
          },
        };
      },
    };
  }

  decodeCursorPosition(cursor: ReceiveCursor): number {
    return this.#cursors.decode(cursor).position;
  }

  async eventHighWater(agentId: AgentId): Promise<number> {
    return (await this.#store.getHighWater(agentId))?.eventPosition ?? 0;
  }

  async idleEventHighWater(agentId: AgentId): Promise<number | null> {
    return (await this.#store.getHighWater(agentId))?.idleEventPosition ?? null;
  }

  async markIdle(agentId: AgentId): Promise<number> {
    const epochs = await this.#store.getEpochs(agentId);
    const epoch = epochs.findLast((candidate) => candidate.state === "open");
    if (epoch === undefined) throw new Error("Agent has no open continuity epoch");
    const idleEventPosition = await this.#store.markIdle(agentId, epoch.epoch);
    this.#notifyEvents(agentId, idleEventPosition);
    return idleEventPosition;
  }

  get activeReceiveStreams(): number {
    return this.#activeReceiveStreams;
  }

  get activeReplayReads(): number {
    return this.#activeReplayReads;
  }

  diagnostics(databasePath: string): Promise<RuntimeJournalDiagnostics> {
    return collectRuntimeJournalDiagnostics({
      store: this.#store,
      databasePath,
      ingestion: this.ingestion,
      activeReceiveStreams: this.#activeReceiveStreams,
      activeReplayReads: this.#activeReplayReads,
    });
  }

  closeIngestion(): Promise<void> {
    return this.ingestion.close();
  }

  async #commit(candidates: readonly JournalCandidate[]): Promise<void> {
    const first = candidates[0];
    if (first === undefined) return;
    if (
      candidates.some(
        (candidate) =>
          candidate.agentId !== first.agentId ||
          candidate.epoch !== first.epoch ||
          candidate.incarnationId !== first.incarnationId,
      )
    ) {
      throw new Error("Journal ingestion batch crosses an agent, incarnation, or continuity epoch");
    }

    const current =
      (await this.#store.getHighWater(first.agentId)) ??
      ({ rawPosition: 0, eventPosition: 0, idleEventPosition: null } satisfies JournalHighWater);
    let nextState =
      (await this.#store.getProjectorState(first.agentId, first.incarnationId, first.epoch)) ??
      initialProjectorState();
    let rawPosition = current.rawPosition;
    let eventPosition = current.eventPosition;
    const records: RawRpcRecord[] = [];
    const events: StoredSemanticEvent[] = [];
    let projectionError: Error | null = null;

    for (const candidate of candidates) {
      rawPosition += 1;
      records.push({
        agentId: candidate.agentId,
        incarnationId: candidate.incarnationId,
        position: rawPosition,
        observedAt: candidate.observedAt,
        bytes: candidate.bytes,
      });
      if (projectionError !== null) continue;
      try {
        const result = projectLifecycleRecord(
          nextState,
          {
            agentId: candidate.agentId,
            epoch: candidate.epoch,
            rawPosition,
            observedAt: candidate.observedAt,
            frame: decodeRecord(candidate.bytes),
          },
          this.#limits.maxOpenProjectorActivities,
        );
        if (
          result.events.some(
            (event) => Buffer.byteLength(JSON.stringify(event)) > this.#limits.maxPiFrameBytes,
          )
        ) {
          throw new Error("Semantic event exceeds the configured storage limit");
        }
        nextState = result.state;
        for (const event of result.events) {
          eventPosition += 1;
          events.push({ agentId: candidate.agentId, position: eventPosition, event });
        }
      } catch (error: unknown) {
        projectionError = error instanceof Error ? error : new Error(String(error));
      }
    }

    const append: JournalAppend = {
      agentId: first.agentId,
      incarnationId: first.incarnationId,
      epoch: first.epoch,
      records,
      events,
      projectorState: nextState,
      highWater: {
        rawPosition,
        eventPosition,
        idleEventPosition: current.idleEventPosition,
      },
    };
    await this.#store.append(append);
    if (events.length > 0) this.#notifyEvents(first.agentId, eventPosition);
    if (projectionError !== null) throw projectionError;
  }
}

export function journalIngestionLimitsFromRuntime(limits: RuntimeLimits): JournalIngestionLimits {
  return {
    maxPendingRecords: limits.maxJournalPendingRecords,
    maxPendingBytes: limits.maxJournalPendingBytes,
    maxPendingBytesPerAgent: limits.maxJournalPendingBytesPerAgent,
    maxBatchRecords: limits.maxJournalBatchRecords,
    maxBatchBytes: limits.maxJournalBatchBytes,
    maxBatchAgeMs: limits.maxJournalBatchAgeMs,
  };
}

export function receivePagerLimitsFromRuntime(limits: RuntimeLimits): ReceivePagerLimits {
  return {
    maxRows: limits.maxReceiveReplayRows,
    maxBytes: limits.maxReceiveReplayBytes,
    maxEventBytes: limits.maxPiFrameBytes,
  };
}

function decodeRecord(bytes: Buffer): unknown {
  let end = bytes.length;
  if (end === 0 || bytes[end - 1] !== 0x0a) throw new Error("RPC record is not LF terminated");
  end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  return JSON.parse(text) as unknown;
}

function defaultNotifyEvents(
  wakeup: ReceiveWakeup,
): NonNullable<JournalRuntimeCompositionOptions["notifyEvents"]> {
  const candidate = wakeup as { notify?: (agentId: AgentId, position: number) => void };
  if (typeof candidate.notify !== "function") {
    throw new Error("Journal composition requires a notifiable receive wakeup");
  }
  const notify = candidate.notify.bind(wakeup);
  return (agentId, position) => notify(agentId, position);
}
