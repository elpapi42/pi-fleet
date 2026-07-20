import { describe, expect, it } from "vitest";

import {
  launchdAgentPlist,
  systemdUserUnit,
} from "../../src/platform/install/service-definition.js";

const options = {
  nodePath: "/usr/local/bin/node",
  runtimePath: "/home/user/.local/share/pi-fleet/releases/v1/dist/runtime.mjs",
  stateRoot: "/home/user/.local/state/pi-fleet",
};

describe("native service definitions", () => {
  it("uses a foreground systemd user service with cgroup cleanup", () => {
    const unit = systemdUserUnit(options);
    expect(unit).toContain(`ExecStart=${options.nodePath} ${options.runtimePath}`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
  });

  it("uses a foreground launchd agent with explicit absolute arguments", () => {
    const plist = launchdAgentPlist(options);
    expect(plist).toContain("works.elpapi.pifleet");
    expect(plist).toContain(`<string>${options.nodePath}</string>`);
    expect(plist).toContain(`<string>${options.runtimePath}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });
});
