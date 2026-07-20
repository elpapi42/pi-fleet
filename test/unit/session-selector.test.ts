import { describe, expect, it } from "vitest";

import {
  analyzeSessionSelector,
  deriveRestorePiArgv,
  type ObservedSession,
} from "../../src/pi/session-selector.js";

const observed: ObservedSession = {
  path: "/tmp/sessions/selected.jsonl",
  id: "01901234-5678-7abc-8def-0123456789ab",
};

describe("native Pi session selection", () => {
  it("preserves an explicit session path exactly", () => {
    const argv = ["--model", "probe/model", "--session", "./chosen.jsonl"];

    expect(analyzeSessionSelector(argv)).toEqual({ kind: "session", value: "./chosen.jsonl" });
    expect(deriveRestorePiArgv(argv, observed)).toEqual(argv);
  });

  it("preserves an exact session id", () => {
    const argv = ["--session-id", observed.id, "--session-dir", "/tmp/sessions"];

    expect(analyzeSessionSelector(argv)).toEqual({ kind: "session-id", value: observed.id });
    expect(deriveRestorePiArgv(argv, observed)).toEqual(argv);
  });

  it.each([
    {
      argv: ["--model", "probe/model"],
      kind: "none",
      restore: ["--model", "probe/model", "--session", observed.path],
    },
    {
      argv: ["--fork", "./source.jsonl", "--thinking", "high"],
      kind: "fork",
      restore: ["--thinking", "high", "--session", observed.path],
    },
    {
      argv: ["--continue", "--session-dir", "/tmp/sessions"],
      kind: "continue",
      restore: ["--session-dir", "/tmp/sessions", "--session", observed.path],
    },
    {
      argv: ["-r"],
      kind: "resume",
      restore: ["--session", observed.path],
    },
  ])("restores $kind through the concrete observed path", ({ argv, kind, restore }) => {
    expect(analyzeSessionSelector(argv).kind).toBe(kind);
    expect(deriveRestorePiArgv(argv, observed)).toEqual(restore);
  });

  it("rejects conflicting primary selectors before launch", () => {
    expect(() => analyzeSessionSelector(["--session", "a.jsonl", "--continue"])).toThrow(
      /conflicting Pi session selectors/i,
    );
  });

  it("requires an observed path for selection operations that must not repeat", () => {
    expect(() =>
      deriveRestorePiArgv(["--fork", "source.jsonl"], { path: null, id: observed.id }),
    ).toThrow(/concrete session path/i);
  });
});
