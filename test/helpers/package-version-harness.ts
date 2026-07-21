import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PackageArtifacts {
  readonly label: string;
  readonly cliPath: string;
  readonly runtimePath: string;
}

export interface CompatibilityEnvironment {
  readonly root: string;
  readonly stateRoot: string;
  readonly applicationRoot: string;
  readonly socketPath: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface RunningRuntime {
  readonly pid: number;
  stop(): Promise<void>;
}

export async function installReleasedPackage(
  version: string,
  prefix: string,
): Promise<PackageArtifacts> {
  await mkdir(prefix, { recursive: true });
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@elpapi42/pi-fleet@${version}`,
    ],
    { timeout: 120_000 },
  );
  const packageRoot = join(prefix, "node_modules", "@elpapi42", "pi-fleet");
  return {
    label: version,
    cliPath: join(packageRoot, "bin", "pifleet.mjs"),
    runtimePath: join(packageRoot, "dist", "runtime.mjs"),
  };
}

export async function createCompatibilityEnvironment(
  root: string,
): Promise<CompatibilityEnvironment> {
  const home = join(root, "home");
  const stateRoot = join(root, "state");
  const applicationRoot = join(root, "application");
  const runtimeRoot = join(root, "runtime");
  const piRoot = join(root, "pi");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(piRoot, { recursive: true }),
  ]);
  return {
    root,
    stateRoot,
    applicationRoot,
    socketPath: join(stateRoot, "control.sock"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: runtimeRoot,
      XDG_STATE_HOME: join(root, "xdg-state"),
      PIFLEET_APPLICATION_ROOT: applicationRoot,
      PIFLEET_STATE_ROOT: stateRoot,
      PIFLEET_DISABLE_REGISTERED_SERVICE: "1",
      PI_CODING_AGENT_DIR: piRoot,
    },
  };
}

export async function startRuntime(
  artifacts: PackageArtifacts,
  environment: CompatibilityEnvironment,
): Promise<RunningRuntime> {
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, [artifacts.runtimePath], {
    cwd: environment.root,
    env: environment.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.reduce((total, value) => total + value.length, 0) < 64 * 1024) {
      stderr.push(Buffer.from(chunk));
    }
  });
  if (child.pid === undefined) throw new Error(`Failed to start runtime ${artifacts.label}`);

  try {
    await waitForSocket(environment.socketPath, child, stderr);
  } catch (error: unknown) {
    await stopChild(child);
    throw error;
  }

  return {
    pid: child.pid,
    stop: async () => {
      await stopChild(child);
      await killProcessesReferencing(environment.applicationRoot);
    },
  };
}

export async function invokeList(
  artifacts: PackageArtifacts,
  environment: CompatibilityEnvironment,
): Promise<unknown> {
  const result = await execFileAsync(process.execPath, [artifacts.cliPath, "list"], {
    cwd: environment.root,
    env: environment.env,
    timeout: 15_000,
  });
  return JSON.parse(result.stdout) as unknown;
}

export async function invokeJsonError(
  artifacts: PackageArtifacts,
  args: readonly string[],
  environment: CompatibilityEnvironment,
): Promise<unknown> {
  try {
    await execFileAsync(process.execPath, [artifacts.cliPath, ...args], {
      cwd: environment.root,
      env: environment.env,
      timeout: 15_000,
    });
  } catch (error: unknown) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    return JSON.parse(stderr) as unknown;
  }
  throw new Error(`Expected ${args.join(" ")} to fail`);
}

export async function socketInode(socketPath: string): Promise<bigint> {
  return (await lstat(socketPath, { bigint: true })).ino;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForSocket(
  socketPath: string,
  child: ChildProcess,
  stderr: readonly Buffer[],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Runtime exited before readiness (${String(child.exitCode)}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    if (await canConnect(socketPath)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    `Runtime did not listen at ${socketPath}: ${Buffer.concat(stderr).toString("utf8")}`,
  );
}

async function canConnect(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolveConnect) => {
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (stopped) return;
  child.kill("SIGKILL");
  await Promise.race([
    once(child, "exit"),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Runtime ${String(child.pid)} did not exit`)), 2_000),
    ),
  ]);
}

async function killProcessesReferencing(root: string): Promise<void> {
  if (process.platform !== "linux") return;
  const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
  const candidates: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid || !Number.isSafeInteger(pid)) continue;
    const command = await readFile(join("/proc", entry.name, "cmdline"))
      .then((value) => value.toString("utf8"))
      .catch(() => "");
    if (command.includes(root)) candidates.push(pid);
  }
  for (const pid of candidates) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between inspection and signalling.
    }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  for (const pid of candidates) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export async function removeCompatibilityRoot(root: string): Promise<void> {
  await killProcessesReferencing(root);
  await rm(root, { recursive: true, force: true });
}
