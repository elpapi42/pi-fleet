import { createHash } from "node:crypto"
import { chmod, mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ConnectOptions } from "../types.js"

export function resolveStateDir(options: ConnectOptions = {}): string {
  if (options.stateDir) return resolve(options.stateDir)
  const stateHome = process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state")
  return resolve(stateHome, "pi-fleet")
}

export function workerEndpoint(stateDir: string, agentId: string, generation: string): string {
  const identity = createHash("sha256").update(`${stateDir}\0${agentId}\0${generation}`).digest("hex").slice(0, 24)
  return `ipc://${join(stateDir, "ipc", `${identity}.sock`)}`
}

export async function prepareStateDir(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  return realpath(stateDir)
}

export async function createStateDirectories(stateDir: string): Promise<void> {
  const canonicalStateDir = await prepareStateDir(stateDir)
  const ipcDir = join(canonicalStateDir, "ipc")
  await mkdir(ipcDir, { recursive: true, mode: 0o700 })
  await chmod(ipcDir, 0o700)
}
