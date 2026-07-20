import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  installUserService,
  uninstallUserService,
  type CommandExecutor,
} from "../../src/platform/install/service-installer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service installer", () => {
  it("installs and removes Linux supervision without touching Fleet or Pi state", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const commands: Array<readonly string[]> = [];
    const executor: CommandExecutor = {
      async run(command, args) {
        commands.push([command, ...args]);
      },
    };
    const stateSentinel = join(home, "state-sentinel");
    await import("node:fs/promises").then((fs) => fs.writeFile(stateSentinel, "keep"));

    const path = await installUserService({
      platform: "linux",
      home,
      executor,
      definition: {
        nodePath: "/usr/bin/node",
        runtimePath: "/home/user/releases/v1/dist/runtime.mjs",
      },
    });
    expect(await readFile(path, "utf8")).toContain("KillMode=control-group");
    expect(commands).toContainEqual(["systemctl", "--user", "enable", "--now", "pi-fleet.service"]);

    await uninstallUserService({ platform: "linux", home, executor });
    await expect(readFile(stateSentinel, "utf8")).resolves.toBe("keep");
  });

  it("generates the launchd lifecycle commands without requiring macOS to inspect them", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const commands: Array<readonly string[]> = [];
    const executor: CommandExecutor = {
      async run(command, args) {
        commands.push([command, ...args]);
      },
    };

    const path = await installUserService({
      platform: "darwin",
      home,
      uid: 501,
      executor,
      definition: {
        nodePath: "/usr/local/bin/node",
        runtimePath: "/Users/user/releases/v1/dist/runtime.mjs",
      },
    });
    expect(await readFile(path, "utf8")).toContain("works.elpapi.pifleet");
    expect(commands).toContainEqual(["launchctl", "bootstrap", "gui/501", path]);
  });
});
