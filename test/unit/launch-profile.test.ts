import { describe, expect, it } from "vitest";

import { createLaunchProfile, observeSession } from "../../src/pi/launch-profile.js";

describe("Pi launch profile", () => {
  it("rejects only Pi modes proven incompatible with persistent headless control", () => {
    for (const piArgv of [["--mode", "json"], ["--print"], ["--no-session"], ["--resume"]]) {
      expect(() => createLaunchProfile({ cwd: "/work", piArgv })).toThrow(/incompatible/i);
    }
  });

  it("rejects positional and @file prompts while preserving option values", () => {
    for (const piArgv of [
      ["bare prompt"],
      ["@prompt.md"],
      ["--approve", "bare prompt"],
      ["--", "prompt"],
    ]) {
      expect(() => createLaunchProfile({ cwd: "/work", piArgv })).toThrow(/prompt/i);
    }

    expect(() =>
      createLaunchProfile({
        cwd: "/work",
        piArgv: ["--model", "provider/model", "--extension-flag", "value", "--approve"],
      }),
    ).not.toThrow();
  });

  it("does not persist Pi ownership and tolerates legacy beta.9 profile data", () => {
    const current = createLaunchProfile({ cwd: "/work", piArgv: [] });
    expect(current).not.toHaveProperty("piArtifactId");

    const legacy = { ...current, piArtifactId: "@earendil-works/pi-coding-agent@0.80.10" };
    const observed = observeSession(legacy, {
      path: "/home/user/.pi/agent/sessions/project/session.jsonl",
      id: "01901234-5678-7abc-8def-0123456789ab",
    });
    expect(observed.restorePiArgv).toEqual([
      "--session",
      "/home/user/.pi/agent/sessions/project/session.jsonl",
    ]);
  });

  it("keeps exact first-launch argv and derives restoration after Pi selects a session", () => {
    const profile = createLaunchProfile({
      cwd: "/work/project",
      piArgv: ["--continue", "--thinking", "high"],
    });

    expect(profile.userPiArgv).toEqual(["--continue", "--thinking", "high"]);
    expect(profile.restorePiArgv).toBeNull();

    const observed = observeSession(profile, {
      path: "/home/user/.pi/agent/sessions/project/session.jsonl",
      id: "01901234-5678-7abc-8def-0123456789ab",
    });

    expect(observed.userPiArgv).toEqual(profile.userPiArgv);
    expect(observed.restorePiArgv).toEqual([
      "--thinking",
      "high",
      "--session",
      "/home/user/.pi/agent/sessions/project/session.jsonl",
    ]);
  });
});
