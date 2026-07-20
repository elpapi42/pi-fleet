import { describe, expect, it } from "vitest";

import { createLaunchProfile, observeSession } from "../../src/pi/launch-profile.js";

describe("Pi launch profile", () => {
  it("rejects only Pi modes proven incompatible with persistent headless control", () => {
    for (const piArgv of [["--mode", "json"], ["--print"], ["--no-session"], ["--resume"]]) {
      expect(() =>
        createLaunchProfile({ cwd: "/work", piArgv, piArtifactId: "pi@0.80.10" }),
      ).toThrow(/incompatible/i);
    }
  });

  it("keeps exact first-launch argv and derives restoration after Pi selects a session", () => {
    const profile = createLaunchProfile({
      cwd: "/work/project",
      piArgv: ["--continue", "--thinking", "high"],
      piArtifactId: "pi@0.80.10",
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
