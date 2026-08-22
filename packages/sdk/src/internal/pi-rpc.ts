import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type { AgentRecord } from "./registry.js"

export type PiState = {
  sessionFile: string
  sessionId: string
}

export class PiStartupError extends Error {}

export async function startPi(record: AgentRecord, timeoutMs = 10_000): Promise<{ process: ChildProcessWithoutNullStreams; state: PiState }> {
  const command = process.env.PI_FLEET_PI_COMMAND ?? "pi"
  const args = ["--mode", "rpc", ...record.piArgs]
  if (record.instructions) args.push("--append-system-prompt", record.instructions)
  if (record.sessionPath) args.push("--session", record.sessionPath)

  const child = spawn(command, args, { cwd: record.cwd, stdio: "pipe" })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096)
  })
  try {
    const state = await getState(child, timeoutMs)
    child.stdout.resume()
    return { process: child, state }
  } catch (error) {
    await terminate(child)
    const detail = stderr.trim()
    if (error instanceof PiStartupError && detail) throw new PiStartupError(`${error.message}: ${detail}`)
    throw error
  }
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  if (await waitForExit(child, 1_000)) return
  child.kill("SIGKILL")
  await waitForExit(child, 1_000)
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

async function getState(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<PiState> {
  const id = "ready"
  const decoder = new StringDecoder("utf8")
  let pending = ""

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new PiStartupError("Pi did not answer get_state before the startup deadline")), timeoutMs)
    const onError = (error: Error) => fail(new PiStartupError(`Pi failed to start: ${error.message}`))
    const onExit = (code: number | null) => fail(new PiStartupError(`Pi exited before readiness (code ${code ?? "signal"})`))
    const onData = (chunk: Buffer) => {
      pending += decoder.write(chunk)
      while (true) {
        const newline = pending.indexOf("\n")
        if (newline < 0) return
        const line = pending.slice(0, newline).replace(/\r$/, "")
        pending = pending.slice(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line)
          if (message.type === "response" && message.id === id) {
            if (!message.success) return fail(new PiStartupError("Pi rejected get_state"))
            const { sessionFile, sessionId } = message.data ?? {}
            if (typeof sessionFile !== "string" || typeof sessionId !== "string") return fail(new PiStartupError("Pi returned an invalid get_state response"))
            cleanup()
            resolve({ sessionFile, sessionId })
          }
        } catch {
          // Pi events and diagnostics may share stdout. Only a matching response matters here.
        }
      }
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }

    child.stdout.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
    child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`)
  })
}
