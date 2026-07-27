import { describe, expect, it } from "vitest";

import {
  SemanticEventReassembler,
  segmentSemanticEvent,
  serializedFrameBytes,
} from "../../src/protocol/semantic-segmentation.js";
import type {
  ActivityId,
  AgentEventId,
  AgentId,
  ContinuityEpoch,
  ReceiveCursor,
  SemanticEvent,
} from "../../src/runtime/semantic-events.js";

const prior = "cursor-0" as ReceiveCursor;

function message(text: string): SemanticEvent {
  return {
    id: "event-1" as AgentEventId,
    activityId: "activity-1" as ActivityId,
    agentId: "agent-1" as AgentId,
    cursor: "cursor-1" as ReceiveCursor,
    epoch: 1 as ContinuityEpoch,
    sourceRawPosition: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    type: "assistant.message.finished",
    text,
  };
}

describe("semantic event segmentation", () => {
  it("keeps every private frame within the limit and reassembles one event", () => {
    const source = message("x".repeat(4_000));
    const frames = segmentSemanticEvent(source, prior, 512);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => serializedFrameBytes(frame) <= 512)).toBe(true);

    const reassembler = new SemanticEventReassembler(10_000);
    let result = null;
    for (const frame of frames) result = reassembler.push(frame) ?? result;
    expect(result).toEqual({ event: source, precedingCursor: prior });
  });

  it("does not yield or advance when reassembly is interrupted", () => {
    const frames = segmentSemanticEvent(message("x".repeat(2_000)), prior, 512);
    const reassembler = new SemanticEventReassembler(10_000);
    expect(reassembler.push(frames[0]!)).toBeNull();
    reassembler.reset();
    expect(() => reassembler.push(frames[1]!)).toThrow(/no start/i);

    let result = null;
    for (const frame of frames) result = reassembler.push(frame) ?? result;
    expect(result?.precedingCursor).toBe(prior);
  });

  it("rejects invalid ordering and events over the reassembly bound", () => {
    const frames = segmentSemanticEvent(message("x".repeat(2_000)), prior, 512);
    const reordered = [frames[0]!, frames[2]!];
    const reassembler = new SemanticEventReassembler(10_000);
    reassembler.push(reordered[0]!);
    expect(() => reassembler.push(reordered[1]!)).toThrow(/sequence/i);

    const bounded = new SemanticEventReassembler(10);
    expect(() => bounded.push(frames[0]!)).toThrow(/reassembly limit/i);
  });

  it("bounds segment metadata and rejects empty segments", () => {
    const frame = segmentSemanticEvent(message("hello"), prior, 512)[0]!;
    const reassembler = new SemanticEventReassembler(10_000, 2);
    expect(() => reassembler.push({ ...frame, count: 3 })).toThrow(/segment count/i);
    expect(() => reassembler.push({ ...frame, data: "" })).toThrow(/must not be empty/i);
    expect(() => segmentSemanticEvent(message("x".repeat(2_000)), prior, 256, 1)).toThrow(
      /too many segments/i,
    );
  });
});
