import { PiRequestUncertainError, PiStartupError, hasUserSessionSelector, type PiDelivery, type PiProcess, type PiState, startPi } from "../pi/runtime.js"
import type { AgentRecord } from "../state/store.js"

const MAX_QUEUED_SENDS = 32
const MAX_QUEUED_BYTES = 1024 * 1024
const RECOVERY_BUDGET_MS = 30_000
const SEND_EXECUTION_MS = 40_000
const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES = 3
const START_DELAYS_MS = [0, 250, 1_000]
const PI_REQUEST_MS = 10_000

type QueuedSend = {
  message: string
  delivery: PiDelivery
  deadlineAt: number
  bytes: number
  resolve: (acceptedAt: number) => void
  reject: (error: unknown) => void
}

type CurrentPi = {
  process: PiProcess
  incarnation: number
}

export type SupervisorSendError = "recovery-queue-full" | "send-uncertain" | "send-expired" | "unavailable"

export class SupervisorSendFailure extends Error {
  readonly code: SupervisorSendError

  constructor(code: SupervisorSendError) {
    super(code)
    this.name = "SupervisorSendFailure"
    this.code = code
  }
}

export type PiSupervisorOptions = {
  initial: AgentRecord
  generation: string
  onPiEvent: (event: unknown) => void
  beforeRecovery: () => Promise<void>
  loadRecord: () => AgentRecord | undefined
  onRecovered: (state: PiState) => Promise<boolean>
  onRecoveryFailed: () => Promise<void>
}

export class PiSupervisor {
  readonly #options: PiSupervisorOptions
  readonly #abort = new AbortController()
  #current: CurrentPi | undefined
  #queue: QueuedSend[] = []
  #queuedBytes = 0
  #activeSend: QueuedSend | undefined
  #recovering = false
  #stopping = false
  #draining = false
  #crashes: number[] = []
  #incarnation = 0
  #recovery: Promise<void> | undefined

  constructor(options: PiSupervisorOptions) {
    this.#options = options
  }

  async start(): Promise<PiState> {
    const current = await this.startRecord(this.#options.initial, PI_REQUEST_MS)
    if (this.#stopping) {
      await current.process.stop()
      throw new Error("Worker is stopping")
    }
    if (!this.sessionMatches(this.#options.initial, current)) {
      await current.process.stop()
      throw new Error("Pi restored a different session")
    }
    this.setCurrent(current)
    return current.process.state
  }

  send(message: string, delivery: PiDelivery, deadlineAt: number): Promise<number> {
    if (this.#stopping) return Promise.reject(new SupervisorSendFailure("unavailable"))
    const now = Date.now()
    const effectiveDeadline = Math.min(deadlineAt, now + SEND_EXECUTION_MS)
    if (effectiveDeadline - now < PI_REQUEST_MS) return Promise.reject(new SupervisorSendFailure("send-expired"))
    const bytes = Buffer.byteLength(message)
    const admittedSends = this.#queue.length + (this.#activeSend ? 1 : 0)
    const admittedBytes = this.#queuedBytes + (this.#activeSend?.bytes ?? 0)
    if (admittedSends >= MAX_QUEUED_SENDS || admittedBytes + bytes > MAX_QUEUED_BYTES) {
      return Promise.reject(new SupervisorSendFailure("recovery-queue-full"))
    }

    return new Promise((resolve, reject) => {
      this.#queue.push({ message, delivery, deadlineAt: effectiveDeadline, bytes, resolve, reject })
      this.#queuedBytes += bytes
      void this.drain()
    })
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#recovery
    this.#stopping = true
    this.#abort.abort()
    this.#incarnation += 1
    this.rejectQueued("unavailable")
    const current = this.#current
    this.#current = undefined
    await current?.process.stop()
    await this.#recovery
  }

  private async drain(): Promise<void> {
    if (this.#draining || this.#recovering || this.#stopping || !this.#current) return
    this.#draining = true
    try {
      while (!this.#recovering && !this.#stopping && this.#current && this.#queue.length > 0) {
        const send = this.#queue.shift()!
        this.#queuedBytes -= send.bytes
        this.#activeSend = send
        try {
          send.resolve(await this.dispatch(send))
        } catch (error) {
          if (error instanceof SendDeferredError) {
            this.#queue.unshift(send)
            this.#queuedBytes += send.bytes
            return
          }
          send.reject(error)
        } finally {
          this.#activeSend = undefined
        }
      }
    } finally {
      this.#draining = false
      if (!this.#recovering && !this.#stopping && this.#current && this.#queue.length > 0) void this.drain()
    }
  }

  private async dispatch(send: QueuedSend): Promise<number> {
    if (send.deadlineAt - Date.now() < PI_REQUEST_MS) throw new SupervisorSendFailure("send-expired")
    const current = this.#current
    if (!current) throw new SupervisorSendFailure("unavailable")
    try {
      await current.process.send(send.message, send.delivery, PI_REQUEST_MS)
      return Date.now()
    } catch (error) {
      if (this.#stopping) throw new SupervisorSendFailure("unavailable")
      if (error instanceof PiRequestUncertainError) throw new SupervisorSendFailure("send-uncertain")
      if (error instanceof PiStartupError && (
        this.#current !== current ||
        current.process.process.exitCode !== null ||
        current.process.process.signalCode !== null
      )) {
        this.deferUntilRecovery(current)
        throw new SendDeferredError()
      }
      throw error
    }
  }

  private deferUntilRecovery(current: CurrentPi): void {
    if (this.#current !== current) return
    this.#current = undefined
    if (this.#incarnation === current.incarnation) this.#incarnation += 1
    this.beginRecovery()
  }

  private setCurrent(current: CurrentPi): void {
    this.#current = current
    current.process.process.once("exit", () => {
      if (this.#stopping || this.#current !== current || current.incarnation !== this.#incarnation) return
      this.#current = undefined
      this.#incarnation += 1
      this.beginRecovery()
    })
  }

  private beginRecovery(): void {
    if (this.#recovering || this.#stopping) return
    this.#recovering = true
    const recovery = this.recover().finally(() => {
      if (this.#recovery === recovery) this.#recovery = undefined
      this.#recovering = false
      if (!this.#stopping && this.#current) void this.drain()
    })
    this.#recovery = recovery
    void recovery
  }

  private async recover(): Promise<void> {
    const now = Date.now()
    this.#crashes = this.#crashes.filter((at) => at >= now - CRASH_WINDOW_MS)
    this.#crashes.push(now)

    const deadline = Date.now() + RECOVERY_BUDGET_MS
    try {
      await this.#options.beforeRecovery()
      if (this.#crashes.length >= MAX_CRASHES) throw new Error("Pi restart limit reached")

      let lastError: unknown
      for (const delay of START_DELAYS_MS) {
        if (this.#stopping || Date.now() >= deadline) break
        if (delay) await wait(delay, this.#abort.signal)
        if (this.#stopping) break

        const record = this.#options.loadRecord()
        if (!record || record.runtime?.generation !== this.#options.generation) throw new RecoveryStoppedError()

        let current: CurrentPi | undefined
        try {
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          current = await this.startRecord(record, Math.min(PI_REQUEST_MS, remaining))
          this.setCurrent(current)

          if (this.#stopping || this.#options.loadRecord()?.runtime?.generation !== this.#options.generation) {
            throw new RecoveryStoppedError()
          }
          if (!this.sessionMatches(record, current)) throw new Error("Pi restored a different session")
          if (this.#current !== current || current.incarnation !== this.#incarnation) throw new Error("Replacement Pi exited before recovery completed")
          if (!(await this.#options.onRecovered(current.process.state))) throw new RecoveryStoppedError()
          if (this.#stopping) throw new RecoveryStoppedError()
          if (this.#current !== current || current.incarnation !== this.#incarnation) throw new Error("Replacement Pi exited before recovery completed")
          return
        } catch (error) {
          if (current) await this.discard(current)
          if (error instanceof RecoveryStoppedError) throw error
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Pi recovery failed")
    } catch {
      this.rejectQueued("unavailable")
      if (!this.#stopping) await this.#options.onRecoveryFailed()
    }
  }

  private sessionMatches(record: AgentRecord, current: CurrentPi): boolean {
    return hasUserSessionSelector(record.piArgs) || !record.sessionId || current.process.state.sessionId === record.sessionId
  }

  private async startRecord(record: AgentRecord, timeoutMs: number): Promise<CurrentPi> {
    const incarnation = ++this.#incarnation
    const process = await startPi(
      { cwd: record.cwd, piArgs: record.piArgs, sessionPath: record.sessionPath },
      timeoutMs,
      (event) => {
        if (!this.#stopping && incarnation === this.#incarnation) this.#options.onPiEvent(event)
      },
      this.#abort.signal,
    )
    return { process, incarnation }
  }

  private async discard(current: CurrentPi): Promise<void> {
    if (this.#current === current) this.#current = undefined
    if (this.#incarnation === current.incarnation) this.#incarnation += 1
    await current.process.stop()
  }

  private rejectQueued(code: SupervisorSendError): void {
    const error = new SupervisorSendFailure(code)
    for (const send of this.#queue.splice(0)) send.reject(error)
    this.#queuedBytes = 0
  }
}

class RecoveryStoppedError extends Error {}
class SendDeferredError extends Error {}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
