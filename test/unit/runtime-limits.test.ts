import { describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_LIMITS, runtimeLimitsFromEnv } from "../../src/shared/runtime-limits.js";

describe("runtime limits", () => {
  it("provides concrete bounded defaults", () => {
    expect(runtimeLimitsFromEnv({})).toEqual(DEFAULT_RUNTIME_LIMITS);
    expect(DEFAULT_RUNTIME_LIMITS.maxResidentProcesses).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxMessageBytes).toBeLessThanOrEqual(
      DEFAULT_RUNTIME_LIMITS.maxProtocolFrameBytes,
    );
    expect(DEFAULT_RUNTIME_LIMITS.maxReceiveStreams).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxJournalPendingRecords).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxJournalPendingBytes).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxJournalPendingBytesPerAgent).toBeLessThanOrEqual(
      DEFAULT_RUNTIME_LIMITS.maxJournalPendingBytes,
    );
    expect(DEFAULT_RUNTIME_LIMITS.journalCheckpointCommitInterval).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.journalReclaimPagesPerPass).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxReceiveReplayRows).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxSemanticFrameBytes).toBeLessThanOrEqual(
      DEFAULT_RUNTIME_LIMITS.maxProtocolFrameBytes,
    );
  });

  it("accepts explicit positive integer overrides", () => {
    expect(runtimeLimitsFromEnv({ PIFLEET_MAX_RESIDENT_PROCESSES: "2" })).toMatchObject({
      maxResidentProcesses: 2,
    });
    expect(
      runtimeLimitsFromEnv({
        PIFLEET_JOURNAL_CHECKPOINT_COMMIT_INTERVAL: "3",
        PIFLEET_JOURNAL_RECLAIM_PAGES_PER_PASS: "4",
      }),
    ).toMatchObject({
      journalCheckpointCommitInterval: 3,
      journalReclaimPagesPerPass: 4,
    });
  });

  it.each(["0", "-1", "1.5", "many"])("rejects invalid overrides: %s", (value) => {
    expect(() => runtimeLimitsFromEnv({ PIFLEET_MAX_SEMANTIC_SEGMENTS: value })).toThrow(
      /positive integer/,
    );
  });
});
