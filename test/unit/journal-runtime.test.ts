import { describe, expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/shared/runtime-limits.js";
import {
  JournalRuntimeComposition,
  journalIngestionLimitsFromRuntime,
  receivePagerLimitsFromRuntime,
} from "../../src/runtime/journal-runtime.js";
import { OpaqueReceiveCursorCodec, type ReceiveWakeup } from "../../src/runtime/receive-pager.js";
import type { AgentId, ContinuityEpoch, IncarnationId } from "../../src/runtime/semantic-events.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";

const agentId = "agent-1" as AgentId;
const incarnationId = "incarnation-1" as IncarnationId;
const epoch = 1 as ContinuityEpoch;

function dormantRuntime(store: MemoryJournalStore) {
  const wakeup: ReceiveWakeup & { notify: () => void } = {
    waitForEvents: (_agentId, _position, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    notify: () => undefined,
  };
  return new JournalRuntimeComposition({
    store,
    limits: { ...DEFAULT_RUNTIME_LIMITS, maxJournalBatchAgeMs: 1 },
    cursors: new OpaqueReceiveCursorCodec(),
    wakeup,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

async function seededStore(): Promise<MemoryJournalStore> {
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
  return store;
}

function record(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

describe("dormant journal runtime composition", () => {
  it("persists exact records and projected events through one ordered path", async () => {
    const store = await seededStore();
    const runtime = dormantRuntime(store);
    const sink = await runtime.openIncarnation({ agentId, incarnationId, epoch });

    await sink.push(
      Buffer.concat([
        record({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
        }),
        record({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ]),
    );
    expect(sink.finish()).toBeNull();
    await expect(sink.push(record({ type: "agent_start" }))).rejects.toThrow(/finished/i);

    expect((await store.getRawRecords(agentId, 0, 10)).map((item) => item.bytes)).toEqual([
      record({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      }),
      record({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
    ]);
    const events = await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 1024 * 1024,
      maxEventBytes: 1024 * 1024,
    });
    expect(events.map((item) => item.event.type)).toEqual([
      "assistant.message.started",
      "assistant.message.finished",
    ]);
    await runtime.closeIngestion();
  });

  it("atomically retains every admitted record when projection fails", async () => {
    const store = await seededStore();
    const runtime = dormantRuntime(store);
    const sink = await runtime.openIncarnation({ agentId, incarnationId, epoch });
    const valid = record({ type: "agent_start" });
    const malformed = Buffer.from([0xff, 0x0a]);
    const later = record({ type: "agent_end" });

    await expect(sink.push(Buffer.concat([valid, malformed, later]))).rejects.toThrow();
    expect((await store.getRawRecords(agentId, 0, 10)).map((item) => item.bytes)).toEqual([
      valid,
      malformed,
      later,
    ]);
  });

  it("resets projector activities before a new incarnation emits records", async () => {
    const store = await seededStore();
    const runtime = dormantRuntime(store);
    const first = await runtime.openIncarnation({ agentId, incarnationId, epoch });
    await first.push(
      record({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "unfinished" },
      }),
    );
    expect(first.finish()).toBeNull();

    const nextIncarnationId = "incarnation-2" as IncarnationId;
    await store.putIncarnation({
      incarnationId: nextIncarnationId,
      agentId,
      pid: 456,
      state: "live",
    });
    const second = await runtime.openIncarnation({
      agentId,
      incarnationId: nextIncarnationId,
      epoch,
    });
    await second.push(
      Buffer.concat([
        record({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "new" },
        }),
        record({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "new" },
        }),
      ]),
    );
    expect(second.finish()).toBeNull();

    const events = await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 1024 * 1024,
      maxEventBytes: 1024 * 1024,
    });
    expect(events.map((item) => item.event.type)).toEqual([
      "assistant.thinking.started",
      "assistant.thinking.started",
      "assistant.thinking.finished",
    ]);
    expect(events[0]?.event.activityId).not.toBe(events[1]?.event.activityId);
    await runtime.closeIngestion();
  });

  it("releases receive accounting when an uniterated stream is cancelled", async () => {
    const store = await seededStore();
    const runtime = dormantRuntime(store);
    const abort = new AbortController();
    await runtime.openReceive(agentId, { kind: "live" }, abort.signal);
    expect(runtime.activeReceiveStreams).toBe(1);
    abort.abort(new Error("cancelled"));
    expect(runtime.activeReceiveStreams).toBe(0);
  });

  it("exposes content-free operational diagnostics through the active composition", async () => {
    const store = await seededStore();
    const runtime = dormantRuntime(store);
    const diagnostics = await runtime.diagnostics("/definitely-absent/pi-fleet.sqlite");
    expect(diagnostics).toMatchObject({
      files: { databaseBytes: 0, walBytes: 0, shmBytes: 0 },
      retained: { agentCount: 1, rawRecordCount: 0, rawBytes: 0, semanticEventCount: 0 },
      ingestion: { pendingRecords: 0, pendingBytes: 0, oldestPendingAgeMs: 0 },
      append: { state: "healthy", lastCommitAt: null, lastDurationMs: null },
      checkpoint: { state: "idle" },
      continuityGapCount: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("workspace");
    await runtime.closeIngestion();
  });

  it("maps runtime limits explicitly into dormant components", () => {
    const limits = {
      ...DEFAULT_RUNTIME_LIMITS,
      maxJournalPendingRecords: 17,
      maxJournalPendingBytes: 18,
      maxJournalPendingBytesPerAgent: 19,
      maxJournalBatchRecords: 20,
      maxJournalBatchBytes: 21,
      maxJournalBatchAgeMs: 22,
      maxReceiveReplayRows: 23,
      maxReceiveReplayBytes: 24,
      maxPiFrameBytes: 25,
    };
    expect(journalIngestionLimitsFromRuntime(limits)).toEqual({
      maxPendingRecords: 17,
      maxPendingBytes: 18,
      maxPendingBytesPerAgent: 19,
      maxBatchRecords: 20,
      maxBatchBytes: 21,
      maxBatchAgeMs: 22,
    });
    expect(receivePagerLimitsFromRuntime(limits)).toEqual({
      maxRows: 23,
      maxBytes: 24,
      maxEventBytes: 25,
    });
  });
});
