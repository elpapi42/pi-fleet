import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  installUserService,
  uninstallUserService,
  type CommandExecutor,
} from "../platform/install/service-installer.js";
import { materializeRuntime } from "../platform/install/runtime-release.js";

const executor: CommandExecutor = {
  async run(command, args) {
    await promisify(execFile)(command, [...args]);
  },
};

export async function installRuntimeService(): Promise<string> {
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const applicationRoot =
    process.env.PIFLEET_APPLICATION_ROOT ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Pi Fleet", "runtime")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pi-fleet"));
  const release = await materializeRuntime({ sourceRoot, applicationRoot });
  const explicitStateRoot = process.env.PIFLEET_STATE_ROOT;
  return installUserService({
    platform: process.platform,
    definition: {
      nodePath: process.execPath,
      runtimePath: join(release, "dist", "runtime.mjs"),
      ...(explicitStateRoot === undefined ? {} : { stateRoot: explicitStateRoot }),
    },
    executor,
  });
}

export async function uninstallRuntimeService(): Promise<void> {
  await uninstallUserService({ platform: process.platform, executor });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "install") {
    process.stdout.write(`${await installRuntimeService()}\n`);
    return;
  }
  if (command === "uninstall") {
    await uninstallRuntimeService();
    return;
  }
  throw new Error("Usage: node dist/installer.mjs <install|uninstall>");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
