import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  installUserService,
  uninstallUserService,
  type CommandExecutor,
} from "../platform/install/service-installer.js";
import { materializeRuntime } from "../platform/install/runtime-release.js";
import { resolveApplicationRoot, resolveFleetPaths } from "../platform/shared/paths.js";

const executor: CommandExecutor = {
  async run(command, args) {
    await promisify(execFile)(command, [...args]);
  },
};

export async function installRuntimeService(): Promise<string> {
  return installMaterializedService(resolveFleetPaths().stateRoot);
}

export async function repairRuntimeService(): Promise<string> {
  return installMaterializedService(process.env.PIFLEET_STATE_ROOT);
}

async function installMaterializedService(stateRoot: string | undefined): Promise<string> {
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const release = await materializeRuntime({
    sourceRoot,
    applicationRoot: resolveApplicationRoot(),
  });
  return installUserService({
    platform: process.platform,
    definition: {
      nodePath: process.execPath,
      runtimePath: join(release, "bin", "pifleet-runtime.mjs"),
      ...(stateRoot === undefined ? {} : { stateRoot }),
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
  if (command === "repair") {
    process.stdout.write(`${await repairRuntimeService()}\n`);
    return;
  }
  if (command === "uninstall") {
    await uninstallRuntimeService();
    return;
  }
  throw new Error("Usage: node dist/installer.mjs <install|repair|uninstall>");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
