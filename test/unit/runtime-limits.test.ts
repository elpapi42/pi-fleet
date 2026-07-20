import { describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_LIMITS, runtimeLimitsFromEnv } from "../../src/shared/runtime-limits.js";

describe("runtime limits", () => {
  it("provides concrete bounded defaults", () => {
    expect(runtimeLimitsFromEnv({})).toEqual(DEFAULT_RUNTIME_LIMITS);
    expect(DEFAULT_RUNTIME_LIMITS.maxResidentProcesses).toBeGreaterThan(0);
    expect(DEFAULT_RUNTIME_LIMITS.maxMessageBytes).toBeLessThanOrEqual(
      DEFAULT_RUNTIME_LIMITS.maxProtocolFrameBytes,
    );
    expect(DEFAULT_RUNTIME_LIMITS.maxWatchers).toBeGreaterThan(0);
  });

  it("accepts explicit positive integer overrides", () => {
    expect(runtimeLimitsFromEnv({ PIFLEET_MAX_RESIDENT_PROCESSES: "2" })).toMatchObject({
      maxResidentProcesses: 2,
    });
  });

  it.each(["0", "-1", "1.5", "many"])("rejects invalid overrides: %s", (value) => {
    expect(() => runtimeLimitsFromEnv({ PIFLEET_MAX_WATCHERS: value })).toThrow(/positive integer/);
  });
});
