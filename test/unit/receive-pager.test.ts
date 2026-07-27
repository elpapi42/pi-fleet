import { describe, expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { initialProjectorState } from "../../src/runtime/lifecycle-projector.js";
import {
  OpaqueReceiveCursorCodec,
  ReceiveObservationUncertainError,
  ReceivePager,
  type ReceiveWakeup,
} from "../../src/runtime/receive-pager.js";
import type {
  ActivityId,
  AgentEventId,
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ReceiveCursor,
  SemanticEvent,
} from "../../src/runtime/semantic-events.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";

const agentId = "agent-1" as AgentId;
const incarnationId = "incarnation-1" as IncarnationId;
const epoch = 1 as ContinuityEpoch;

function event(position: number, eventEpoch = epoch): SemanticEvent {
  const id = `event-${position}` as AgentEventId;
  return {
    id,
    activityId: `activity-${position}` as ActivityId,
    agentId,
    cursor: id as unknown as ReceiveCursor,
    epoch: eventEpoch,
    sourceRawPosition: position,
    observedAt: "2026-01-01T00:00:00.000Z",
    type: "assistant.message.finished",
    text: `message ${position}`,
  };
}

async function storeWithEvents(count: number): Promise<MemoryJournalStore> {
  const store = new MemoryJournalStore();
  await store.createAgent({
    agentId,
    name: "reviewer",
    summary: {
      id: agentId,
      name: "reviewer",
      state: "idle",
      process: { state: "absent" },
      session: { id: null, path: null },
    },
    launch: createLaunchProfile({ cwd: "/workspace", piArgv: [] }),
  });
  await store.putIncarnation({ incarnationId, agentId, pid: 123, state: "live" });
  await store.putEpoch({
    agentId,
    epoch,
    state: "open",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());
  if (count > 0) {
    await store.append({
      agentId,
      incarnationId,
      epoch,
      records: Array.from({ length: count }, (_, index) => ({
        agentId,
        incarnationId: "incarnation-1" as IncarnationId,
        position: index + 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        bytes: Buffer.from(`{"position":${index + 1}}\n`),
      })),
      events: Array.from({ length: count }, (_, index) => ({
        agentId,
        position: index + 1,
        event: event(index + 1),
      })),
      projectorState: {
        version: 1,
        messageSequence: count,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: count, eventPosition: count, idleEventPosition: count },
    });
  }
  return store;
}

class NeverWake implements ReceiveWakeup {
  waitForEvents(_agentId: AgentId, _afterPosition: number, signal: AbortSignal): Promise<void> {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

describe("ReceivePager", () => {
  it("establishes a live cursor before yielding only later events", async () => {
    const store = await storeWithEvents(1);
    const codec = new OpaqueReceiveCursorCodec();
    const controller = new AbortController();
    const stream = await new ReceivePager(store, codec, new NeverWake(), {
      maxRows: 10,
      maxBytes: 10_000,
      maxEventBytes: 100_000,
    }).open(agentId, { kind: "live" }, controller.signal);

    expect(codec.decode(stream.cursor)).toMatchObject({ agentId, epoch, position: 1 });
    await store.append({
      agentId,
      incarnationId,
      epoch,
      records: [
        {
          agentId,
          incarnationId: "incarnation-1" as IncarnationId,
          position: 2,
          observedAt: "2026-01-01T00:00:01.000Z",
          bytes: Buffer.from("{}\n"),
        },
      ],
      events: [{ agentId, position: 2, event: event(2) }],
      projectorState: {
        version: 1,
        messageSequence: 2,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 2, eventPosition: 2, idleEventPosition: 2 },
    });

    const iterator = stream[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.value).toMatchObject({ id: "event-2", text: "message 2" });
    expect(codec.decode(next.value!.cursor)).toMatchObject({ position: 2 });
    controller.abort(new Error("done"));
  });

  it("replays from start and rejects a cursor for another generation", async () => {
    const store = await storeWithEvents(2);
    const codec = new OpaqueReceiveCursorCodec();
    const controller = new AbortController();
    const pager = new ReceivePager(store, codec, new NeverWake(), {
      maxRows: 1,
      maxBytes: 10_000,
      maxEventBytes: 100_000,
    });
    const stream = await pager.open(agentId, { kind: "start" }, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe("event-1");
    expect((await iterator.next()).value?.id).toBe("event-2");
    controller.abort(new Error("done"));

    const wrong = codec.encode({ agentId: "agent-2" as AgentId, epoch, position: 0 });
    await expect(
      pager.open(agentId, { kind: "after", cursor: wrong }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "cursor_wrong_agent" });
  });

  it("rejects an event larger than the bounded replay page", async () => {
    const store = await storeWithEvents(1);
    const pager = new ReceivePager(store, new OpaqueReceiveCursorCodec(), new NeverWake(), {
      maxRows: 10,
      maxBytes: 8,
      maxEventBytes: 8,
    });
    const stream = await pager.open(agentId, { kind: "start" }, new AbortController().signal);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/exceeds/i);
  });

  it("stops at an uncertain epoch and crosses only with its continuation cursor", async () => {
    const store = await storeWithEvents(1);
    await store.putEpoch({
      agentId,
      epoch,
      state: "closed",
      lastSafeEventPosition: 1,
      openedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "2026-01-01T00:00:01.000Z",
      reason: "observation_uncertain",
    });
    const nextEpoch = 2 as ContinuityEpoch;
    const nextIncarnationId = "incarnation-2" as IncarnationId;
    await store.putIncarnation({
      incarnationId: nextIncarnationId,
      agentId,
      pid: 456,
      state: "live",
    });
    await store.putEpoch({
      agentId,
      epoch: nextEpoch,
      state: "open",
      lastSafeEventPosition: 1,
      openedAt: "2026-01-01T00:00:02.000Z",
    });
    await store.beginIncarnation(agentId, nextIncarnationId, nextEpoch, initialProjectorState());
    await store.append({
      agentId,
      incarnationId: nextIncarnationId,
      epoch: nextEpoch,
      records: [
        {
          agentId,
          incarnationId: nextIncarnationId,
          position: 2,
          observedAt: "2026-01-01T00:00:02.000Z",
          bytes: Buffer.from("{}\n"),
        },
      ],
      events: [{ agentId, position: 2, event: event(2, nextEpoch) }],
      projectorState: {
        version: 1,
        messageSequence: 2,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 2, eventPosition: 2, idleEventPosition: 2 },
    });

    const codec = new OpaqueReceiveCursorCodec();
    const pager = new ReceivePager(store, codec, new NeverWake(), {
      maxRows: 10,
      maxBytes: 10_000,
      maxEventBytes: 100_000,
    });
    const stream = await pager.open(agentId, { kind: "start" }, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe("event-1");

    let gap: ReceiveObservationUncertainError | undefined;
    try {
      await iterator.next();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReceiveObservationUncertainError);
      gap = error as ReceiveObservationUncertainError;
    }
    expect(codec.decode(gap!.lastSafeCursor)).toMatchObject({ epoch, position: 1 });
    expect(codec.decode(gap!.continuationCursor!)).toEqual({
      agentId,
      epoch: nextEpoch,
      position: 1,
      kind: "continuation",
    });

    const resumed = await pager.open(
      agentId,
      { kind: "after", cursor: gap!.continuationCursor! },
      new AbortController().signal,
    );
    expect((await resumed[Symbol.asyncIterator]().next()).value?.id).toBe("event-2");

    const live = await pager.open(agentId, { kind: "live" }, new AbortController().signal);
    expect(codec.decode(live.cursor)).toMatchObject({ epoch: nextEpoch, position: 2 });

    const invalidSkip = codec.encode({
      agentId,
      epoch: nextEpoch,
      position: 0,
      kind: "continuation",
    });
    await expect(
      pager.open(agentId, { kind: "after", cursor: invalidSkip }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
  });
});
