import { describe, expect, it } from "vitest";

import { parseDuration } from "../../src/shared/duration.js";

describe("parseDuration", () => {
  it("parses supported unit durations", () => {
    expect(parseDuration("0")).toEqual({ ok: true, value: 0 });
    expect(parseDuration("250ms")).toEqual({ ok: true, value: 250 });
    expect(parseDuration("30s")).toEqual({ ok: true, value: 30_000 });
    expect(parseDuration("2m")).toEqual({ ok: true, value: 120_000 });
  });

  it("rejects malformed and negative durations", () => {
    expect(parseDuration("-1s")).toEqual({ ok: false, error: "invalid_duration" });
    expect(parseDuration("soon")).toEqual({ ok: false, error: "invalid_duration" });
  });
});
