import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
}): Promise<void> {
  if (await canConnect(options.socketPath)) return;

  const env = { ...process.env, ...options.env };
  const registered =
    env.PIFLEET_DISABLE_REGISTERED_SERVICE === "1"
      ? false
      : await startRegisteredRuntime({
          env,
          ...(options.home === undefined ? {} : { home: options.home }),
        });
  if (!registered) {
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
    if (await canConnect(options.socketPath)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Pi Fleet runtime did not become ready at ${options.socketPath}`);
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
      `Registered Pi Fleet service uses the default state root, but this command requested ${requested}. Run the Pi Fleet installer with PIFLEET_STATE_ROOT=${requested} to repair the service, or omit the override.`,
    );
  }
  if (resolve(installed) !== requested) {
    throw new Error(
      `Registered Pi Fleet service uses state root ${installed}, but this command requested ${requested}. Repair the service with the intended PIFLEET_STATE_ROOT before retrying.`,
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
  throw new Error("Unable to locate the Pi Fleet package runtime manifest.");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveConnect(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveConnect(false);
    });
  });
}
