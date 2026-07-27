import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { PiInstallation } from "../../pi/external-installation.js";
import {
  inspectControlSocketOwnership,
  RuntimeOwnershipBlockedError,
  type ControlSocketOwnership,
} from "../shared/runtime-ownership.js";
import { materializeRuntime } from "../install/runtime-release.js";
import { resolveApplicationRoot, resolveFleetPaths } from "../shared/paths.js";

const execFileAsync = promisify(execFile);

export async function ensureRuntime(options: {
  readonly socketPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly sourceRoot?: string;
  readonly applicationRoot?: string;
  readonly home?: string;
  readonly piInstallation?: () => Promise<PiInstallation | null>;
  readonly registeredRuntimeStarter?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  readonly inspectOwnership?: (socketPath: string) => Promise<ControlSocketOwnership>;
}): Promise<void> {
  const inspectOwnership = options.inspectOwnership ?? inspectControlSocketOwnership;
  const initialOwnership = await inspectOwnership(options.socketPath);
  if (initialOwnership === "responsive") return;
  assertRuntimeStartAllowed(initialOwnership, options.socketPath);

  let env = { ...process.env, ...options.env };
  const registered =
    env.PIFLEET_DISABLE_REGISTERED_SERVICE === "1"
      ? false
      : options.registeredRuntimeStarter !== undefined
        ? await options.registeredRuntimeStarter(env)
        : await startRegisteredRuntime({
            env,
            ...(options.home === undefined ? {} : { home: options.home }),
          });
  if (!registered) {
    if (options.piInstallation !== undefined) {
      const installation = await options.piInstallation();
      if (installation !== null) {
        env = {
          ...env,
          PIFLEET_PI_EXECUTABLE: installation.selectedPath,
          PIFLEET_PI_NODE: installation.nodePath,
        };
      }
    }
    const sourceRoot =
      options.sourceRoot ?? (await findPackageRoot(fileURLToPath(import.meta.url)));
    const release = await materializeRuntime({
      sourceRoot,
      applicationRoot: options.applicationRoot ?? resolveApplicationRoot(env),
    });
    const runtimePath = join(release, "bin", "pifleet-runtime.mjs");
    const child = spawn(process.execPath, [runtimePath], {
      detached: true,
      env,
      stdio: "ignore",
    });
    child.unref();
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const ownership = await inspectOwnership(options.socketPath);
    if (ownership === "responsive") return;
    if (ownership === "uncertain") {
      throw new RuntimeOwnershipBlockedError(
        `pi-fleet control socket ownership is uncertain for ${options.socketPath}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`pi-fleet runtime did not become ready at ${options.socketPath}`);
}

function assertRuntimeStartAllowed(
  ownership: Exclude<ControlSocketOwnership, "responsive">,
  socketPath: string,
): void {
  if (ownership === "uncertain") {
    throw new RuntimeOwnershipBlockedError(
      `pi-fleet control socket ownership is uncertain for ${socketPath}`,
    );
  }
}

async function startRegisteredRuntime(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
}): Promise<boolean> {
  const home = options.home ?? homedir();
  if (process.platform === "linux") {
    const unit = join(home, ".config", "systemd", "user", "pi-fleet.service");
    if (!(await exists(unit))) return false;
    await assertRegisteredStateRoot(unit, "linux", options.env);
    await execFileAsync("systemctl", ["--user", "start", "pi-fleet.service"]);
    return true;
  }
  if (process.platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", "works.elpapi.pifleet.plist");
    if (!(await exists(plist))) return false;
    await assertRegisteredStateRoot(plist, "darwin", options.env);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFileAsync("launchctl", ["kickstart", `${domain}/works.elpapi.pifleet`]);
    return true;
  }
  return false;
}

export function installedServiceStateRoot(
  contents: string,
  platform: "linux" | "darwin",
): string | undefined {
  const encoded =
    platform === "linux"
      ? /^Environment=PIFLEET_STATE_ROOT=(.+)$/m.exec(contents)?.[1]
      : /<key>PIFLEET_STATE_ROOT<\/key><string>([^<]+)<\/string>/.exec(contents)?.[1];
  if (encoded === undefined) return undefined;
  if (platform === "linux") return encoded;
  return encoded
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export class PiServiceMismatchError extends Error {
  readonly code = "pi_service_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "PiServiceMismatchError";
  }
}

export async function assertRegisteredPiSelection(options: {
  readonly selectedPath: string;
  readonly nodePath: string;
  readonly home?: string;
}): Promise<void> {
  const home = options.home ?? homedir();
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin") return;
  const path =
    platform === "linux"
      ? join(home, ".config", "systemd", "user", "pi-fleet.service")
      : join(home, "Library", "LaunchAgents", "works.elpapi.pifleet.plist");
  if (!(await exists(path))) return;
  const contents = await readFile(path, "utf8");
  const installed = installedServicePiExecutable(contents, platform);
  const installedNode = installedServicePiNode(contents, platform);
  if (
    installed === undefined ||
    installedNode === undefined ||
    resolve(installed) !== resolve(options.selectedPath) ||
    resolve(installedNode) !== resolve(options.nodePath)
  ) {
    throw new PiServiceMismatchError(
      `The installed pi-fleet service uses a different Pi executable or Node interpreter; repair it from the environment selecting ${options.selectedPath}.`,
    );
  }
}

export function installedServicePiExecutable(
  contents: string,
  platform: "linux" | "darwin",
): string | undefined {
  return installedServiceEnvironmentValue(contents, platform, "PIFLEET_PI_EXECUTABLE");
}

export function installedServicePiNode(
  contents: string,
  platform: "linux" | "darwin",
): string | undefined {
  return installedServiceEnvironmentValue(contents, platform, "PIFLEET_PI_NODE");
}

function installedServiceEnvironmentValue(
  contents: string,
  platform: "linux" | "darwin",
  key: "PIFLEET_PI_EXECUTABLE" | "PIFLEET_PI_NODE",
): string | undefined {
  const encoded =
    platform === "linux"
      ? new RegExp(`Environment=(?:"${key}=([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|${key}=(.+))$`, "m")
          .exec(contents)
          ?.slice(1)
          .find(Boolean)
      : new RegExp(`<key>${key}<\\/key><string>([^<]+)<\\/string>`).exec(contents)?.[1];
  if (encoded === undefined) return undefined;
  if (platform === "darwin") {
    return encoded
      .replaceAll("&apos;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&");
  }
  return encoded.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

async function assertRegisteredStateRoot(
  definitionPath: string,
  platform: "linux" | "darwin",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const installed = installedServiceStateRoot(await readFile(definitionPath, "utf8"), platform);
  const requested = resolve(resolveFleetPaths(env).stateRoot);
  if (installed === undefined) {
    if (env.PIFLEET_STATE_ROOT === undefined) return;
    throw new Error(
      `Registered pi-fleet service uses the default state root, but this command requested ${requested}. Run the pi-fleet installer with PIFLEET_STATE_ROOT=${requested} to repair the service, or omit the override.`,
    );
  }
  if (resolve(installed) !== requested) {
    throw new Error(
      `Registered pi-fleet service uses state root ${installed}, but this command requested ${requested}. Repair the service with the intended PIFLEET_STATE_ROOT before retrying.`,
    );
  }
}

async function findPackageRoot(modulePath: string): Promise<string> {
  let candidate = dirname(modulePath);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await exists(join(candidate, "dist", "runtime-manifest.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Unable to locate the pi-fleet package runtime manifest.");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
