import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

export async function ensureRuntime(options: {
  readonly socketPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<void> {
  if (await canConnect(options.socketPath)) return;

  const runtimePath = fileURLToPath(new URL("./runtime.mjs", import.meta.url));
  const child = spawn(process.execPath, [runtimePath], {
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (await canConnect(options.socketPath)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Pi Fleet runtime did not become ready at ${options.socketPath}`);
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
