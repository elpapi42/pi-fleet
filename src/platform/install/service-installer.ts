import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  launchdAgentPlist,
  systemdUserUnit,
  type ServiceDefinitionOptions,
} from "./service-definition.js";

export interface CommandExecutor {
  run(command: string, args: readonly string[]): Promise<void>;
}

export async function installUserService(options: {
  readonly platform: NodeJS.Platform;
  readonly definition: ServiceDefinitionOptions;
  readonly executor: CommandExecutor;
  readonly home?: string;
  readonly uid?: number;
}): Promise<string> {
  const home = options.home ?? homedir();
  if (options.platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "pi-fleet.service");
    const definition = systemdUserUnit(options.definition);
    const needsRepair = await serviceDefinitionNeedsRepair(path, definition, options.definition);
    if (needsRepair) {
      await atomicWrite(path, definition);
      await options.executor.run("systemctl", ["--user", "daemon-reload"]);
    }
    await options.executor.run("systemctl", ["--user", "enable", "--now", "pi-fleet.service"]);
    if (needsRepair) {
      await options.executor.run("systemctl", ["--user", "restart", "pi-fleet.service"]);
    }
    return path;
  }
  if (options.platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", "works.elpapi.pifleet.plist");
    await atomicWrite(path, launchdAgentPlist(options.definition));
    const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
    await options.executor.run("launchctl", ["bootout", domain, path]).catch(() => undefined);
    await options.executor.run("launchctl", ["bootstrap", domain, path]);
    await options.executor.run("launchctl", ["kickstart", `${domain}/works.elpapi.pifleet`]);
    return path;
  }
  throw new Error(`Native Pi Fleet supervision is unsupported on ${options.platform}`);
}

export async function uninstallUserService(options: {
  readonly platform: NodeJS.Platform;
  readonly executor: CommandExecutor;
  readonly home?: string;
  readonly uid?: number;
}): Promise<void> {
  const home = options.home ?? homedir();
  if (options.platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "pi-fleet.service");
    await options.executor.run("systemctl", ["--user", "disable", "--now", "pi-fleet.service"]);
    await rm(path, { force: true });
    await options.executor.run("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  if (options.platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", "works.elpapi.pifleet.plist");
    const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
    await options.executor.run("launchctl", ["bootout", domain, path]).catch(() => undefined);
    await rm(path, { force: true });
    return;
  }
  throw new Error(`Native Pi Fleet supervision is unsupported on ${options.platform}`);
}

export async function serviceDefinitionNeedsRepair(
  path: string,
  expectedContents: string,
  definition: ServiceDefinitionOptions,
): Promise<boolean> {
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== expectedContents) return true;
  try {
    await access(definition.nodePath, constants.X_OK);
    await access(definition.runtimePath, constants.R_OK);
    return false;
  } catch {
    return true;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
