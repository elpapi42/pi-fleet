import type { ReceiveCursorCodec, ReceiveStart } from "../client/agent-target.js";
import type { ReceiveStream } from "../client/contracts.js";
import type { JournalReceiveSnapshot, JournalStore } from "../store/journal-store.js";
import type { AgentId, ReceiveCursor, SemanticEvent } from "./semantic-events.js";

export type { ReceiveStream } from "../client/contracts.js";

interface CursorPayload {
  readonly v: 1;
  readonly a: string;
  readonly e: number;
  readonly p: number;
  readonly k?: "continuation";
}

export class ReceiveBoundaryError extends Error {
  constructor(readonly code: "cursor_invalid" | "cursor_expired" | "cursor_wrong_agent") {
    super("Receive cursor cannot be used.");
    this.name = "ReceiveBoundaryError";
  }
}

export class OpaqueReceiveCursorCodec implements ReceiveCursorCodec {
  readonly version = 1 as const;

  encode(boundary: {
    readonly agentId: AgentId;
    readonly epoch: number;
    readonly position: number;
    readonly kind?: "position" | "continuation";
  }): ReceiveCursor {
    assertPosition(boundary.position);
    assertPosition(boundary.epoch);
    const payload: CursorPayload = {
      v: this.version,
      a: boundary.agentId,
      e: boundary.epoch,
      p: boundary.position,
      ...(boundary.kind === "continuation" ? { k: "continuation" as const } : {}),
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64url") as ReceiveCursor;
  }

  decode(cursor: ReceiveCursor): {
    readonly agentId: AgentId;
    readonly epoch: number;
    readonly position: number;
    readonly kind: "position" | "continuation";
  } {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw new ReceiveBoundaryError("cursor_invalid");
    }
    if (!isCursorPayload(value)) throw new ReceiveBoundaryError("cursor_invalid");
    return {
      agentId: value.a as AgentId,
      epoch: value.e,
      position: value.p,
      kind: value.k === "continuation" ? "continuation" : "position",
    };
  }
}

export interface ReceiveWakeup {
  /** Must resolve immediately when persisted event position is already greater than afterPosition. */
  waitForEvents(agentId: AgentId, afterPosition: number, signal: AbortSignal): Promise<void>;
}

export interface ReceivePagerLimits {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
}

export interface ReceivePagerActivity {
  readonly onReadStart?: () => void;
  readonly onReadEnd?: () => void;
}

export class ReceiveObservationUncertainError extends Error {
  readonly code = "observation_uncertain" as const;

  constructor(
    readonly lastSafeCursor: ReceiveCursor,
    readonly continuationCursor: ReceiveCursor | null,
  ) {
    super("Receive observation continuity is uncertain");
    this.name = "ReceiveObservationUncertainError";
  }
}

export class ReceivePager {
  constructor(
    private readonly store: JournalStore,
    private readonly cursors: ReceiveCursorCodec,
    private readonly wakeup: ReceiveWakeup,
    private readonly limits: ReceivePagerLimits,
    private readonly activity: ReceivePagerActivity = {},
  ) {
    assertPositiveInteger(limits.maxRows, "Receive replay row limit");
    assertPositiveInteger(limits.maxBytes, "Receive replay byte limit");
    assertPositiveInteger(limits.maxEventBytes, "Receive semantic event limit");
  }

  async open(agentId: AgentId, start: ReceiveStart, signal: AbortSignal): Promise<ReceiveStream> {
    throwIfAborted(signal);
    const snapshot = await this.store.openReceive(agentId);
    if (snapshot === null) throw codedError("agent_not_found", "Agent generation was not found");
    const boundary = this.#boundary(snapshot, start);
    const initialCursor = this.cursors.encode(boundary);
    return {
      cursor: initialCursor,
      [Symbol.asyncIterator]: () =>
        this.#events(agentId, boundary.epoch, boundary.position, signal),
    };
  }

  #boundary(
    snapshot: JournalReceiveSnapshot,
    start: ReceiveStart,
  ): { readonly agentId: AgentId; readonly epoch: number; readonly position: number } {
    const latest = snapshot.epochs.at(-1);
    if (latest === undefined) throw codedError("state_corrupt", "Agent has no continuity epoch");
    if (start.kind === "live") {
      return {
        agentId: snapshot.agent.agentId,
        epoch: latest.epoch,
        position: snapshot.highWater.eventPosition,
      };
    }
    if (start.kind === "start") {
      return {
        agentId: snapshot.agent.agentId,
        epoch: snapshot.epochs[0]?.epoch ?? latest.epoch,
        position: 0,
      };
    }

    const decoded = this.cursors.decode(start.cursor);
    if (decoded.agentId !== snapshot.agent.agentId) {
      throw new ReceiveBoundaryError("cursor_wrong_agent");
    }
    const epochIndex = snapshot.epochs.findIndex((epoch) => epoch.epoch === decoded.epoch);
    if (epochIndex < 0) throw new ReceiveBoundaryError("cursor_expired");
    if (decoded.position > snapshot.highWater.eventPosition) {
      throw new ReceiveBoundaryError("cursor_invalid");
    }
    const selectedEpoch = snapshot.epochs[epochIndex]!;
    if (
      selectedEpoch.state === "closed" &&
      decoded.kind === "position" &&
      decoded.position > selectedEpoch.lastSafeEventPosition
    ) {
      throw new ReceiveBoundaryError("cursor_invalid");
    }
    if (decoded.kind === "continuation") {
      const previous = snapshot.epochs[epochIndex - 1];
      if (
        previous === undefined ||
        previous.state !== "closed" ||
        previous.reason !== "observation_uncertain" ||
        previous.lastSafeEventPosition !== decoded.position
      ) {
        throw new ReceiveBoundaryError("cursor_invalid");
      }
    }
    return decoded;
  }

  async *#events(
    agentId: AgentId,
    initialEpoch: number,
    initialPosition: number,
    signal: AbortSignal,
  ): AsyncGenerator<SemanticEvent> {
    let epoch = initialEpoch;
    let position = initialPosition;
    while (true) {
      throwIfAborted(signal);
      this.activity.onReadStart?.();
      const page = await this.store
        .readEvents({
          agentId,
          epoch: epoch as SemanticEvent["epoch"],
          afterPosition: position,
          limit: this.limits.maxRows,
          maxBytes: this.limits.maxBytes,
          maxEventBytes: this.limits.maxEventBytes,
        })
        .finally(() => this.activity.onReadEnd?.());
      if (page.length > 0) {
        for (const stored of page) {
          const cursor = this.cursors.encode({
            agentId,
            epoch: stored.event.epoch,
            position: stored.position,
          });
          position = stored.position;
          yield { ...stored.event, cursor };
        }
        continue;
      }

      const snapshot = await this.store.openReceive(agentId);
      if (snapshot === null) throw codedError("agent_destroyed", "Agent was destroyed");
      const epochIndex = snapshot.epochs.findIndex((candidate) => candidate.epoch === epoch);
      if (epochIndex < 0) throw new ReceiveBoundaryError("cursor_expired");
      const current = snapshot.epochs[epochIndex]!;
      const next = snapshot.epochs[epochIndex + 1];
      if (current.state === "closed" && position >= current.lastSafeEventPosition) {
        if (current.reason === "observation_uncertain") {
          const lastSafeCursor = this.cursors.encode({
            agentId,
            epoch: current.epoch,
            position: current.lastSafeEventPosition,
          });
          const continuationCursor =
            next === undefined
              ? null
              : this.cursors.encode({
                  agentId,
                  epoch: next.epoch,
                  position: current.lastSafeEventPosition,
                  kind: "continuation",
                });
          throw new ReceiveObservationUncertainError(lastSafeCursor, continuationCursor);
        }
        if (next !== undefined) {
          epoch = next.epoch;
          continue;
        }
      }
      await this.wakeup.waitForEvents(agentId, position, signal);
    }
  }
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<CursorPayload>;
  return (
    payload.v === 1 &&
    (payload.k === undefined || payload.k === "continuation") &&
    typeof payload.a === "string" &&
    payload.a.length > 0 &&
    Number.isSafeInteger(payload.e) &&
    (payload.e ?? -1) >= 0 &&
    Number.isSafeInteger(payload.p) &&
    (payload.p ?? -1) >= 0
  );
}

function assertPosition(value: number, label = "Receive cursor position"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Receive cancelled");
}
