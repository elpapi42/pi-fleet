import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

export function launchWorker(stateDir: string, agentId: string, generation: string): ChildProcess {
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url))
  const child = spawn(process.execPath, [workerPath, "--state-dir", stateDir, "--agent", agentId, "--generation", generation], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()
  return child
}
