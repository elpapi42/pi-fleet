import type { AgentEventId, ReceiveCursor, SemanticEvent } from "../runtime/semantic-events.js";

export interface SemanticSegmentFrame {
  readonly type: "semantic.segment";
  readonly eventId: AgentEventId;
  readonly precedingCursor: ReceiveCursor;
  readonly eventCursor: ReceiveCursor;
  readonly index: number;
  readonly count: number;
  readonly data: string;
}

export interface ReassembledSemanticEvent {
  readonly event: SemanticEvent;
  readonly precedingCursor: ReceiveCursor;
}

export function segmentSemanticEvent(
  event: SemanticEvent,
  precedingCursor: ReceiveCursor,
  maxFrameBytes: number,
  maxSegments = 4_096,
): readonly SemanticSegmentFrame[] {
  assertPositiveInteger(maxFrameBytes, "Semantic frame limit");
  assertPositiveInteger(maxSegments, "Semantic segment limit");
  const payload = Buffer.from(JSON.stringify(event));
  let low = 1;
  let high = payload.length;
  let accepted: readonly SemanticSegmentFrame[] | null = null;

  while (low <= high) {
    const chunkBytes = Math.floor((low + high) / 2);
    const candidate = makeFrames(event, precedingCursor, payload, chunkBytes);
    if (candidate.every((frame) => serializedFrameBytes(frame) <= maxFrameBytes)) {
      accepted = candidate;
      low = chunkBytes + 1;
    } else {
      high = chunkBytes - 1;
    }
  }

  if (accepted === null) throw new Error("Semantic frame limit is too small for metadata");
  if (accepted.length > maxSegments) {
    throw new Error("Semantic event requires too many segments");
  }
  return accepted;
}

export class SemanticEventReassembler {
  readonly #maxEventBytes: number;
  readonly #maxSegments: number;
  #current:
    | {
        readonly eventId: AgentEventId;
        readonly precedingCursor: ReceiveCursor;
        readonly eventCursor: ReceiveCursor;
        readonly count: number;
        readonly chunks: Buffer[];
        bytes: number;
      }
    | undefined;

  constructor(maxEventBytes: number, maxSegments = 4_096) {
    assertPositiveInteger(maxEventBytes, "Semantic event reassembly limit");
    assertPositiveInteger(maxSegments, "Semantic segment limit");
    this.#maxEventBytes = maxEventBytes;
    this.#maxSegments = maxSegments;
  }

  push(frame: SemanticSegmentFrame): ReassembledSemanticEvent | null {
    assertFrame(frame);
    if (frame.count > this.#maxSegments) {
      throw new Error("Semantic event segment count exceeds reassembly limit");
    }
    if (frame.data.length === 0) throw new Error("Semantic event segment must not be empty");
    if (frame.index === 0) {
      if (this.#current !== undefined) throw new Error("Semantic event reassembly was interrupted");
      this.#current = {
        eventId: frame.eventId,
        precedingCursor: frame.precedingCursor,
        eventCursor: frame.eventCursor,
        count: frame.count,
        chunks: [],
        bytes: 0,
      };
    }
    const current = this.#current;
    if (current === undefined) throw new Error("Semantic event segment has no start");
    if (
      frame.eventId !== current.eventId ||
      frame.precedingCursor !== current.precedingCursor ||
      frame.eventCursor !== current.eventCursor ||
      frame.count !== current.count ||
      frame.index !== current.chunks.length
    ) {
      this.reset();
      throw new Error("Semantic event segment sequence is invalid");
    }

    const chunk = decodeBase64(frame.data);
    if (current.bytes + chunk.length > this.#maxEventBytes) {
      this.reset();
      throw new Error("Semantic event exceeds reassembly limit");
    }
    current.chunks.push(chunk);
    current.bytes += chunk.length;
    if (current.chunks.length < current.count) return null;

    const precedingCursor = current.precedingCursor;
    const eventCursor = current.eventCursor;
    const eventId = current.eventId;
    const bytes = Buffer.concat(current.chunks, current.bytes);
    this.reset();
    let event: SemanticEvent;
    try {
      event = JSON.parse(bytes.toString("utf8")) as SemanticEvent;
    } catch {
      throw new Error("Semantic event payload is invalid JSON");
    }
    if (event.id !== eventId || event.cursor !== eventCursor) {
      throw new Error("Semantic event payload identity does not match its segments");
    }
    return { event, precedingCursor };
  }

  reset(): void {
    this.#current = undefined;
  }
}

export function serializedFrameBytes(frame: SemanticSegmentFrame): number {
  return Buffer.byteLength(JSON.stringify(frame));
}

function makeFrames(
  event: SemanticEvent,
  precedingCursor: ReceiveCursor,
  payload: Buffer,
  chunkBytes: number,
): readonly SemanticSegmentFrame[] {
  const count = Math.ceil(payload.length / chunkBytes);
  const frames: SemanticSegmentFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    frames.push({
      type: "semantic.segment",
      eventId: event.id,
      precedingCursor,
      eventCursor: event.cursor,
      index,
      count,
      data: payload.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
    });
  }
  return frames;
}

function assertFrame(frame: SemanticSegmentFrame): void {
  if (
    frame.type !== "semantic.segment" ||
    !Number.isSafeInteger(frame.index) ||
    !Number.isSafeInteger(frame.count) ||
    frame.index < 0 ||
    frame.count <= 0 ||
    frame.index >= frame.count
  ) {
    throw new Error("Semantic event segment metadata is invalid");
  }
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error("Semantic event segment is invalid base64");
  return decoded;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}
