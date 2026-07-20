import { readFileSync, readdirSync } from "node:fs";

export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (process.platform === "linux") {
    const record = readLinuxProcess(pid);
    if (record === null) return false;
    if (record !== undefined) return isRunningState(record.state);
  }
  return canSignal(pid);
}

export function isProcessGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32") return isProcessAlive(processGroupId);
  if (process.platform === "linux") {
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const record = readLinuxProcess(Number(entry));
        if (
          record !== null &&
          record !== undefined &&
          record.processGroupId === processGroupId &&
          isRunningState(record.state)
        ) {
          return true;
        }
      }
      return false;
    } catch {
      // Fall back to the portable signal probe if procfs is unavailable.
    }
  }
  return canSignal(-processGroupId);
}

export async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<boolean> {
  return waitUntilGone(() => isProcessAlive(pid), timeoutMs);
}

export async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs = 1_000,
): Promise<boolean> {
  return waitUntilGone(() => isProcessGroupAlive(processGroupId), timeoutMs);
}

function readLinuxProcess(
  pid: number,
): { readonly state: string; readonly processGroupId: number } | null | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    const processGroupId = Number(fields[2]);
    if (state === undefined || !Number.isSafeInteger(processGroupId)) return undefined;
    return { state, processGroupId };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
}

function isRunningState(state: string): boolean {
  return state !== "Z" && state !== "X";
}

function canSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilGone(isAlive: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !isAlive();
}
