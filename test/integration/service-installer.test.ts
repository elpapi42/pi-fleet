import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureRuntime } from "../../src/platform/client/start-runtime.js";
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
    const service = await readFile(path, "utf8");
    expect(service).toContain("KillMode=control-group");
    expect(service).not.toContain("Environment=PIFLEET_STATE_ROOT=");
    expect(commands).toContainEqual(["systemctl", "--user", "enable", "--now", "pi-fleet.service"]);

    await uninstallUserService({ platform: "linux", home, executor });
    await expect(readFile(stateSentinel, "utf8")).resolves.toBe("keep");
  });

  it("is idempotent and repairs changed or missing launch targets", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const commands: Array<readonly string[]> = [];
    const executor: CommandExecutor = {
      async run(command, args) {
        commands.push([command, ...args]);
      },
    };
    const nodePath = join(home, "node");
    const replacementNodePath = join(home, "node-replacement");
    const runtimePath = join(home, "runtime.mjs");
    await Promise.all([
      writeFile(nodePath, "#!/bin/sh\n"),
      writeFile(replacementNodePath, "#!/bin/sh\n"),
      writeFile(runtimePath, "export {};\n"),
    ]);
    await Promise.all([chmod(nodePath, 0o700), chmod(replacementNodePath, 0o700)]);
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });

    const definition = { nodePath, runtimePath };
    await installUserService({ platform: "linux", home, executor, definition });
    await installUserService({ platform: "linux", home, executor, definition });
    expect(commands.filter((command) => command.at(-2) === "restart")).toHaveLength(1);

    await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath: replacementNodePath, runtimePath },
    });
    expect(commands.filter((command) => command.at(-2) === "restart")).toHaveLength(2);

    await rm(replacementNodePath);
    await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath: replacementNodePath, runtimePath },
    });
    expect(commands.filter((command) => command.at(-2) === "restart")).toHaveLength(3);
  });

  it("preserves the installed state root when repair is invoked without one", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const executor: CommandExecutor = { async run() {} };
    const nodePath = join(home, "node");
    const runtimePath = join(home, "runtime.mjs");
    await Promise.all([writeFile(nodePath, "#!/bin/sh\n"), writeFile(runtimePath, "export {};\n")]);
    await chmod(nodePath, 0o700);

    const path = await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath, runtimePath, stateRoot: "/custom/fleet-state" },
    });
    await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath, runtimePath },
    });

    expect(await readFile(path, "utf8")).toContain(
      "Environment=PIFLEET_STATE_ROOT=/custom/fleet-state",
    );
  });

  it("rejects a CLI state root that differs from the registered service", async () => {
    if (process.platform !== "linux") return;
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const serviceDirectory = join(home, ".config", "systemd", "user");
    await mkdir(serviceDirectory, { recursive: true });
    await writeFile(
      join(serviceDirectory, "pi-fleet.service"),
      "[Service]\nEnvironment=PIFLEET_STATE_ROOT=/installed/state\n",
    );

    await expect(
      ensureRuntime({
        socketPath: join(home, "requested", "control.sock"),
        env: { ...process.env, PIFLEET_STATE_ROOT: join(home, "requested") },
        home,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/service uses state root \/installed\/state.*requested/i);
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
