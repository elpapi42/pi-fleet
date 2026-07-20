import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureRuntime(options: {
  readonly socketPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<void> {
  if (await canConnect(options.socketPath)) return;

  const registered = await startRegisteredRuntime();
  if (!registered) {
    const runtimePath = fileURLToPath(new URL("./runtime.mjs", import.meta.url));
    const child = spawn(process.execPath, [runtimePath], {
      detached: true,
      env: { ...process.env, ...options.env },
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

async function startRegisteredRuntime(): Promise<boolean> {
  if (process.platform === "linux") {
    const unit = join(homedir(), ".config", "systemd", "user", "pi-fleet.service");
    if (!(await exists(unit))) return false;
    await execFileAsync("systemctl", ["--user", "start", "pi-fleet.service"]);
    return true;
  }
  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "works.elpapi.pifleet.plist");
    if (!(await exists(plist))) return false;
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFileAsync("launchctl", ["kickstart", `${domain}/works.elpapi.pifleet`]);
    return true;
  }
  return false;
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
