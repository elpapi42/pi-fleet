import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertRegisteredPiSelection,
  ensureRuntime,
} from "../../src/platform/client/start-runtime.js";
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
  it("installs and removes Linux supervision without touching pi-fleet or Pi state", async () => {
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
      replaceExisting: true,
      ownershipPreflight: async () => undefined,
      definition: { nodePath: replacementNodePath, runtimePath },
    });
    expect(commands.filter((command) => command.at(-2) === "restart")).toHaveLength(2);

    await rm(replacementNodePath);
    await installUserService({
      platform: "linux",
      home,
      executor,
      replaceExisting: true,
      ownershipPreflight: async () => undefined,
      definition: { nodePath: replacementNodePath, runtimePath },
    });
    expect(commands.filter((command) => command.at(-2) === "restart")).toHaveLength(3);
  });

  it("defers explicit service replacement when ownership proof is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const commands: Array<readonly string[]> = [];
    const executor: CommandExecutor = {
      async run(command, args) {
        commands.push([command, ...args]);
      },
    };
    const nodePath = join(home, "node");
    const runtimePath = join(home, "runtime.mjs");
    const replacementRuntimePath = join(home, "runtime-v2.mjs");
    await Promise.all([
      writeFile(nodePath, "#!/bin/sh\n"),
      writeFile(runtimePath, "export {};\n"),
      writeFile(replacementRuntimePath, "export {};\n"),
    ]);
    await chmod(nodePath, 0o700);
    const path = await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath, runtimePath },
    });
    const before = await readFile(path, "utf8");
    const commandCount = commands.length;

    await expect(
      installUserService({
        platform: "linux",
        home,
        executor,
        replaceExisting: true,
        definition: { nodePath, runtimePath: replacementRuntimePath },
      }),
    ).rejects.toMatchObject({ code: "runtime_upgrade_deferred" });

    expect(await readFile(path, "utf8")).toBe(before);
    expect(commands).toHaveLength(commandCount);
  });

  it("runs ownership preflight before replacing an installed definition", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const executor: CommandExecutor = { async run() {} };
    const nodePath = join(home, "node");
    const runtimePath = join(home, "runtime.mjs");
    const replacementRuntimePath = join(home, "runtime-v2.mjs");
    await Promise.all([
      writeFile(nodePath, "#!/bin/sh\n"),
      writeFile(runtimePath, "export {};\n"),
      writeFile(replacementRuntimePath, "export {};\n"),
    ]);
    await chmod(nodePath, 0o700);
    const path = await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath, runtimePath },
    });
    const before = await readFile(path, "utf8");
    let inspectedBeforeWrite = false;

    await installUserService({
      platform: "linux",
      home,
      executor,
      replaceExisting: true,
      ownershipPreflight: async () => {
        expect(await readFile(path, "utf8")).toBe(before);
        inspectedBeforeWrite = true;
      },
      definition: { nodePath, runtimePath: replacementRuntimePath },
    });

    expect(inspectedBeforeWrite).toBe(true);
    expect(await readFile(path, "utf8")).not.toBe(before);
  });

  it("defers changed service replacement without modifying the installed definition", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const executor: CommandExecutor = { async run() {} };
    const nodePath = join(home, "node");
    const runtimePath = join(home, "runtime.mjs");
    const replacementRuntimePath = join(home, "runtime-v2.mjs");
    await Promise.all([
      writeFile(nodePath, "#!/bin/sh\n"),
      writeFile(runtimePath, "export {};\n"),
      writeFile(replacementRuntimePath, "export {};\n"),
    ]);
    await chmod(nodePath, 0o700);
    const path = await installUserService({
      platform: "linux",
      home,
      executor,
      definition: { nodePath, runtimePath },
    });
    const before = await readFile(path, "utf8");

    await expect(
      installUserService({
        platform: "linux",
        home,
        executor,
        replaceExisting: false,
        definition: { nodePath, runtimePath: replacementRuntimePath },
      }),
    ).rejects.toMatchObject({ code: "runtime_upgrade_deferred" });

    expect(await readFile(path, "utf8")).toBe(before);
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

  it("starts a registered control plane for passive use without resolving terminal Pi", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const socketPath = join(home, "runtime", "control.sock");
    await mkdir(join(home, "runtime"), { recursive: true });
    let resolutionCalls = 0;
    const server = createServer();

    await ensureRuntime({
      socketPath,
      home,
      timeoutMs: 500,
      piInstallation: async () => {
        resolutionCalls += 1;
        throw new Error("Pi must not be resolved for registered passive startup");
      },
      registeredRuntimeStarter: async () => {
        server.listen(socketPath);
        await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
        return true;
      },
    });

    expect(resolutionCalls).toBe(0);
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
    );
  });

  it("does not start or materialize when socket ownership is uncertain", async () => {
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    let starterCalls = 0;
    let piResolutionCalls = 0;

    await expect(
      ensureRuntime({
        socketPath: join(home, "runtime", "control.sock"),
        home,
        inspectOwnership: async () => "uncertain",
        registeredRuntimeStarter: async () => {
          starterCalls += 1;
          return false;
        },
        piInstallation: async () => {
          piResolutionCalls += 1;
          throw new Error("Pi resolution must not run for uncertain ownership");
        },
      }),
    ).rejects.toMatchObject({ code: "runtime_upgrade_deferred" });

    expect(starterCalls).toBe(0);
    expect(piResolutionCalls).toBe(0);
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

  it("rejects a terminal-selected Pi that differs from the registered service", async () => {
    if (process.platform !== "linux") return;
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const serviceDirectory = join(home, ".config", "systemd", "user");
    await mkdir(serviceDirectory, { recursive: true });
    await writeFile(
      join(serviceDirectory, "pi-fleet.service"),
      '[Service]\nEnvironment="PIFLEET_PI_EXECUTABLE=/installed/pi"\nEnvironment="PIFLEET_PI_NODE=/installed/node"\n',
    );
    const selectedPath = join(home, "terminal pi");

    await expect(
      assertRegisteredPiSelection({ selectedPath, nodePath: join(home, "terminal node"), home }),
    ).rejects.toMatchObject({
      code: "pi_service_mismatch",
    });
  });

  it("rejects a terminal-selected Node that differs from the registered service", async () => {
    if (process.platform !== "linux") return;
    const home = await mkdtemp(join(tmpdir(), "pifleet-service-"));
    roots.push(home);
    const serviceDirectory = join(home, ".config", "systemd", "user");
    await mkdir(serviceDirectory, { recursive: true });
    await writeFile(
      join(serviceDirectory, "pi-fleet.service"),
      '[Service]\nEnvironment="PIFLEET_PI_EXECUTABLE=/installed/pi"\nEnvironment="PIFLEET_PI_NODE=/installed/node"\n',
    );

    await expect(
      assertRegisteredPiSelection({
        selectedPath: "/installed/pi",
        nodePath: "/terminal/node",
        home,
      }),
    ).rejects.toMatchObject({ code: "pi_service_mismatch" });
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
