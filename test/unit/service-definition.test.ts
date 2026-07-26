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

  it("persists exact Pi and Node paths with spaces and Unicode", () => {
    const selected = {
      ...options,
      piExecutablePath: "/home/user/Pi Tools/π/bin/pi",
      piNodePath: "/home/user/Node Tools/bin/node",
    };
    const unit = systemdUserUnit(selected);
    expect(unit).toContain('Environment="PIFLEET_PI_EXECUTABLE=/home/user/Pi Tools/π/bin/pi"');
    expect(unit).toContain('Environment="PIFLEET_PI_NODE=/home/user/Node Tools/bin/node"');

    const plist = launchdAgentPlist(selected);
    expect(plist).toContain(
      "<key>PIFLEET_PI_EXECUTABLE</key><string>/home/user/Pi Tools/π/bin/pi</string>",
    );
    expect(plist).toContain(
      "<key>PIFLEET_PI_NODE</key><string>/home/user/Node Tools/bin/node</string>",
    );
  });
});
