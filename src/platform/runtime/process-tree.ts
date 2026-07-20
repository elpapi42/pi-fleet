export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  return canSignal(pid);
}

export function isProcessGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32") return isProcessAlive(processGroupId);
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
