import { describe, expect, it, vi } from "vitest";

import {
  JournalIngestionScheduler,
  type JournalIngressRecord,
  type JournalIngestionLimits,
} from "../../src/runtime/journal-ingestion.js";
import type { AgentId } from "../../src/runtime/semantic-events.js";

const agentA = "agent-a" as AgentId;
const agentB = "agent-b" as AgentId;

const limits: JournalIngestionLimits = {
  maxPendingRecords: 8,
  maxPendingBytes: 64,
  maxPendingBytesPerAgent: 16,
  maxBatchRecords: 2,
  maxBatchBytes: 8,
  maxBatchAgeMs: 10,
};

function record(agentId: AgentId, value: string, bytes = value): JournalIngressRecord<string> {
  return { agentId, value, bytes: Buffer.from(bytes) };
}

describe("JournalIngestionScheduler", () => {
  it("batches one agent atomically while scheduling agents fairly", async () => {
    const commits: string[][] = [];
    const scheduler = new JournalIngestionScheduler<string>({
      limits,
      commit: async (batch) => {
        commits.push(batch.map((item) => item.value));
      },
    });

    const completions = [
      scheduler.enqueue(record(agentA, "a1")),
      scheduler.enqueue(record(agentA, "a2")),
      scheduler.enqueue(record(agentB, "b1")),
    ];
    await scheduler.drain();
    await Promise.all(completions);

    expect(commits).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("pauses at high water and resumes below low water", async () => {
    vi.useFakeTimers();
    const paused: AgentId[] = [];
    const resumed: AgentId[] = [];
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxPendingBytesPerAgent: 4 },
      commit: async () => undefined,
      pauseAgent: (agentId) => paused.push(agentId),
      resumeAgent: (agentId) => resumed.push(agentId),
    });

    const completion = scheduler.enqueue(record(agentA, "one", "abc"));
    expect(paused).toEqual([agentA]);
    await vi.advanceTimersByTimeAsync(10);
    await completion;
    expect(resumed).toEqual([agentA]);
    vi.useRealTimers();
  });

  it("pauses all queued agents under global pressure", async () => {
    vi.useFakeTimers();
    const paused: AgentId[] = [];
    const resumed: AgentId[] = [];
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxPendingBytes: 8, maxBatchRecords: 8 },
      commit: async () => undefined,
      pauseAgent: (agentId) => paused.push(agentId),
      resumeAgent: (agentId) => resumed.push(agentId),
    });

    const first = scheduler.enqueue(record(agentA, "a", "abc"));
    const second = scheduler.enqueue(record(agentB, "b", "def"));
    expect(new Set(paused)).toEqual(new Set([agentA, agentB]));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    expect(new Set(resumed)).toEqual(new Set([agentA, agentB]));
    vi.useRealTimers();
  });

  it("fails an agent closed when admission capacity is exceeded", async () => {
    const failures: AgentId[] = [];
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxPendingRecords: 2 },
      commit: async () => undefined,
      failAgent: (agentId) => failures.push(agentId),
    });

    const first = scheduler.enqueue(record(agentA, "a1"));
    const second = scheduler.enqueue(record(agentA, "a2"));
    const overflow = scheduler.enqueue(record(agentA, "a3"));

    await expect(overflow).rejects.toThrow("capacity exceeded");
    await expect(first).rejects.toThrow("capacity exceeded");
    await expect(second).rejects.toThrow("capacity exceeded");
    await expect(scheduler.enqueue(record(agentA, "a4"))).rejects.toThrow("capacity exceeded");
    expect(failures).toEqual([agentA]);
  });

  it("isolates a commit failure to affected agents without resuming failed work", async () => {
    const failure = new Error("disk unavailable");
    const failedAgents: AgentId[] = [];
    const resumed: AgentId[] = [];
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxBatchRecords: 1, maxPendingBytesPerAgent: 2 },
      commit: async () => {
        throw failure;
      },
      resumeAgent: (agentId) => resumed.push(agentId),
      failAgent: (agentId) => failedAgents.push(agentId),
    });

    await expect(scheduler.enqueue(record(agentA, "a1"))).rejects.toBe(failure);
    await expect(scheduler.enqueue(record(agentA, "a2"))).rejects.toBe(failure);
    expect(failedAgents).toEqual([agentA]);
    expect(resumed).toEqual([]);
  });

  it("settles admitted work when commit throws synchronously", async () => {
    const failure = new Error("synchronous storage failure");
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxBatchRecords: 1 },
      commit: () => {
        throw failure;
      },
    });

    await expect(scheduler.enqueue(record(agentA, "a1"))).rejects.toBe(failure);
    expect(scheduler.pendingRecords).toBe(0);
    expect(scheduler.pendingBytes).toBe(0);
    await scheduler.drain();
  });

  it("takes ownership of admitted bytes", async () => {
    let committed: Buffer | undefined;
    const scheduler = new JournalIngestionScheduler<string>({
      limits: { ...limits, maxBatchRecords: 1 },
      commit: async ([item]) => {
        committed = item?.bytes;
      },
    });
    const bytes = Buffer.from("a");
    const completion = scheduler.enqueue({ agentId: agentA, bytes, value: "a" });
    bytes[0] = 0x62;
    await completion;
    expect(committed).toEqual(Buffer.from("a"));
  });

  it("stops admission before draining during close", async () => {
    const scheduler = new JournalIngestionScheduler<string>({
      limits,
      commit: async () => undefined,
    });

    const closing = scheduler.close();
    await expect(scheduler.enqueue(record(agentA, "late"))).rejects.toThrow(
      "Journal ingestion is closed",
    );
    await closing;
  });
});
