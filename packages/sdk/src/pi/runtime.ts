import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

export type PiLaunch = {
  cwd: string
  piArgs: string[]
  sessionPath?: string
}

export type PiState = {
  sessionFile: string
  sessionId: string
}

export type PiDelivery = "steer" | "followUp"
export type PiEventHandler = (event: unknown) => void

export type PiProcess = {
  process: ChildProcessWithoutNullStreams
  state: PiState
  send(message: string, delivery: PiDelivery, timeoutMs?: number): Promise<void>
  stop(): Promise<void>
}

export class PiStartupError extends Error {}
export class PiRequestError extends Error {}

const USER_SESSION_SELECTORS = new Set([
  "--session",
  "--session-id",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--fork",
])

class PiRpcClient {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #onEvent?: PiEventHandler
  readonly #pending = new Map<string, {
    resolve: (response: Record<string, unknown>) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()
  readonly #decoder = new StringDecoder("utf8")
  #buffer = ""
  #closed = false

  constructor(process: ChildProcessWithoutNullStreams, onEvent?: PiEventHandler) {
    this.#process = process
    this.#onEvent = onEvent
    process.stdout.on("data", this.onStdout)
    process.once("exit", this.onExit)
    process.once("error", this.onError)
    process.stdin.once("error", this.onStdinError)
  }

  async getState(timeoutMs: number): Promise<PiState> {
    const response = await this.request({ type: "get_state" }, timeoutMs)
    const data = response.data
    if (!isRecord(data) || typeof data.sessionFile !== "string" || typeof data.sessionId !== "string") {
      throw new PiStartupError("Pi returned an invalid get_state response")
    }
    return { sessionFile: data.sessionFile, sessionId: data.sessionId }
  }

  async send(message: string, delivery: PiDelivery, timeoutMs = 10_000): Promise<void> {
    await this.request({ type: "prompt", message, streamingBehavior: delivery }, timeoutMs)
  }

  close(): void {
    this.#closed = true
    this.#process.stdout.off("data", this.onStdout)
    this.#process.off("exit", this.onExit)
    this.#process.off("error", this.onError)
    this.#process.stdin.off("error", this.onStdinError)
    this.rejectPending(new PiStartupError("Pi RPC client closed"))
  }

  private request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#closed || this.#process.exitCode !== null || this.#process.signalCode !== null || this.#process.stdin.destroyed) {
      return Promise.reject(new PiStartupError("Pi is not available"))
    }

    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new PiRequestError("Pi did not answer before the request deadline"))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timeout })
      try {
        this.#process.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
      } catch (error) {
        this.rejectRequest(id, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onStdout = (chunk: Buffer): void => {
    this.#buffer += this.#decoder.write(chunk)
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "")
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(message)) return

    if (message.type === "response") {
      if (typeof message.id === "string" && this.#pending.has(message.id)) {
        if (message.success === true) this.resolveRequest(message.id, message)
        else this.rejectRequest(message.id, new PiRequestError(typeof message.error === "string" ? message.error : "Pi rejected the request"))
      }
      return
    }

    this.#onEvent?.(message)
  }

  private onExit = (code: number | null): void => {
    this.#closed = true
    this.rejectPending(new PiStartupError(`Pi exited before completing the request (code ${code ?? "signal"})`))
  }

  private onError = (error: Error): void => {
    this.#closed = true
    this.rejectPending(new PiStartupError(`Pi failed: ${error.message}`))
  }

  private onStdinError = (error: Error): void => {
    this.#closed = true
    this.rejectPending(new PiStartupError(`Pi stdin failed: ${error.message}`))
  }

  private resolveRequest(id: string, response: Record<string, unknown>): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.resolve(response)
  }

  private rejectRequest(id: string, error: Error): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(error)
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }
}

export async function startPi(launch: PiLaunch, timeoutMs = 10_000, onEvent?: PiEventHandler): Promise<PiProcess> {
  const command = process.env.PI_FLEET_PI_COMMAND ?? "pi"
  const args = ["--mode", "rpc", ...launch.piArgs]
  if (launch.sessionPath && !launch.piArgs.some((arg) => USER_SESSION_SELECTORS.has(arg))) {
    args.push("--session", launch.sessionPath)
  }

  const child = spawn(command, args, { cwd: launch.cwd, stdio: "pipe" })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096)
  })
  const rpc = new PiRpcClient(child, onEvent)
  try {
    const state = await rpc.getState(timeoutMs)
    return {
      process: child,
      state,
      send: (message, delivery, requestTimeoutMs) => rpc.send(message, delivery, requestTimeoutMs),
      stop: () => stopPi(child),
    }
  } catch (error) {
    rpc.close()
    await stopPi(child)
    const detail = stderr.trim()
    const message = error instanceof Error ? error.message : String(error)
    throw new PiStartupError(detail ? `${message}: ${detail}` : message)
  }
}

export async function stopPi(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child) return
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
