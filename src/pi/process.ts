import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { signalProcessTree, waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import { RpcRecordFramer } from "./rpc-record-framer.js";

const DEFAULT_MAX_STDOUT_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PARTIAL_RECORD_BYTES = 64 * 1024 * 1024;

export class PiRpcRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcRejectedError";
  }
}

export interface PiCompactionResult {
  readonly tokensBefore: number;
  readonly estimatedTokensAfter?: number;
}

export class PiCompactionError extends Error {
  constructor(readonly code: "nothing_to_compact" | "compaction_failed") {
    super(code);
    this.name = "PiCompactionError";
  }
}

export class PiResponseCommitDelayError extends Error {
  readonly code = "storage_unavailable" as const;

  constructor() {
    super("Pi responded, but pi-fleet could not durably commit the response in time");
    this.name = "PiResponseCommitDelayError";
  }
}

export class PiCleanupUncertainError extends Error {
  constructor(
    readonly pid: number,
    readonly startupError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(`Pi process group ${String(pid)} could not be cleaned up after startup failed`);
    this.name = "PiCleanupUncertainError";
  }
}

export interface PiState {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly pendingMessageCount: number;
  readonly sessionFile?: string;
  readonly sessionId: string;
}

export interface PiFrame {
  readonly id?: string;
  readonly type?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly error?: string;
  readonly data?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export type PiDeliveryMode = "steer" | "followUp";

/**
 * A future durable stdout pipeline uses this state to avoid mistaking an
 * observed matching response for a Pi timeout while its journal commit waits.
 * The active parser still resolves responses immediately in Phase 1.
 */
export type PiResponseAdmissionState =
  | "awaiting_response"
  | "admitted_pending_commit"
  | "committed"
  | "failed";

export class PiResponseAdmission {
  #state: PiResponseAdmissionState = "awaiting_response";

  get state(): PiResponseAdmissionState {
    return this.#state;
  }

  admit(): void {
    if (this.#state !== "awaiting_response") {
      throw new Error(`Cannot admit response while ${this.#state}`);
    }
    this.#state = "admitted_pending_commit";
  }

  commit(): void {
    if (this.#state !== "admitted_pending_commit") {
      throw new Error(`Cannot commit response while ${this.#state}`);
    }
    this.#state = "committed";
  }

  fail(): void {
    if (this.#state === "committed") {
      throw new Error("Cannot fail a committed response");
    }
    this.#state = "failed";
  }
}

export interface PiProcessStartOptions {
  readonly executable: string;
  readonly argvPrefix?: readonly string[];
  readonly piArgv: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxStdoutFrameBytes?: number;
  readonly maxPartialRecordBytes?: number;
  readonly onSpawn?: (pid: number) => Promise<void>;
  /** Called after a complete LF-terminated record is admitted and before it becomes observable. */
  readonly onStdoutRecord?: (record: Buffer) => void | Promise<void>;
  /** Test/adapter compatibility only; production runtime uses onStdoutRecord. */
  readonly onStdoutBytes?: (record: Buffer) => void;
}

interface ResponseWaiter {
  readonly resolve: (frame: PiFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly admission: PiResponseAdmission;
}

export class PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #responses = new Map<string, ResponseWaiter>();
  readonly #listeners = new Set<(frame: PiFrame) => void>();
  readonly #exitListeners = new Set<(error: Error | null) => void>();
  readonly #stdoutFramer: RpcRecordFramer;
  #stderr = "";
  #stopping = false;
  #handledExit = false;
  readonly #exitHandled: Promise<void>;
  #resolveExitHandled: () => void = () => undefined;
  readonly #maxStdoutFrameBytes: number;
  readonly #onStdoutRecord: (record: Buffer) => Promise<void>;
  #stdoutLane: Promise<void> = Promise.resolve();
  #stdoutFailure: Error | null = null;

  private constructor(options: PiProcessStartOptions) {
    this.#exitHandled = new Promise((resolve) => {
      this.#resolveExitHandled = resolve;
    });
    this.#maxStdoutFrameBytes = options.maxStdoutFrameBytes ?? DEFAULT_MAX_STDOUT_FRAME_BYTES;
    this.#stdoutFramer = new RpcRecordFramer(
      options.maxPartialRecordBytes ?? DEFAULT_MAX_PARTIAL_RECORD_BYTES,
    );
    this.#onStdoutRecord = async (record) => {
      if (options.onStdoutRecord !== undefined) await options.onStdoutRecord(record);
      else options.onStdoutBytes?.(record);
    };
    this.#child = spawn(
      options.executable,
      [...(options.argvPrefix ?? []), "--mode", "rpc", ...options.piArgv],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#child.stdout.pause();
      this.#stdoutLane = this.#stdoutLane
        .then(() => this.#consumeStdout(chunk))
        .catch((error: unknown) => this.#failStdout(error))
        .finally(() => {
          if (this.#child.exitCode === null && this.#stdoutFailure === null) {
            this.#child.stdout.resume();
          }
        });
    });
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-65_536);
    });
    this.#child.once("exit", (code, signal) => void this.#handleExit(code, signal));
    this.#child.once("error", (error) => void this.#handleExit(null, null, error));
  }

  static async start(options: PiProcessStartOptions): Promise<PiProcess> {
    const process = new PiProcess(options);
    try {
      await options.onSpawn?.(process.pid);
      await process.getState();
      return process;
    } catch (error: unknown) {
      try {
        await process.stop();
      } catch (cleanupError: unknown) {
        throw new PiCleanupUncertainError(process.pid, error, cleanupError);
      }
      throw error;
    }
  }

  get pid(): number {
    if (this.#child.pid === undefined) throw new Error("Pi process has no PID");
    return this.#child.pid;
  }

  get stderr(): string {
    return this.#stderr;
  }

  onFrame(listener: (frame: PiFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async getState(): Promise<PiState> {
    const frame = await this.request({ type: "get_state" });
    return frame.data as unknown as PiState;
  }

  async prompt(message: string): Promise<void> {
    await this.request({ type: "prompt", message, streamingBehavior: "steer" });
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: "follow_up", message });
  }

  async compact(): Promise<PiCompactionResult> {
    let frame: PiFrame;
    try {
      frame = await this.request({ type: "compact" });
    } catch (error: unknown) {
      if (!(error instanceof PiRpcRejectedError)) throw error;
      const code =
        error.message === "Already compacted" || error.message.startsWith("Nothing to compact")
          ? "nothing_to_compact"
          : "compaction_failed";
      throw new PiCompactionError(code);
    }
    const tokensBefore = frame.data?.tokensBefore;
    const estimatedTokensAfter = frame.data?.estimatedTokensAfter;
    if (
      typeof tokensBefore !== "number" ||
      !Number.isFinite(tokensBefore) ||
      tokensBefore < 0 ||
      (estimatedTokensAfter !== undefined &&
        (typeof estimatedTokensAfter !== "number" ||
          !Number.isFinite(estimatedTokensAfter) ||
          estimatedTokensAfter < 0))
    ) {
      throw new Error("Pi returned an invalid compaction result");
    }
    return {
      tokensBefore,
      ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
    };
  }

  async getLastAssistantText(): Promise<string | null> {
    const frame = await this.request({ type: "get_last_assistant_text" });
    return typeof frame.data?.text === "string" ? frame.data.text : null;
  }

  async request(command: Record<string, unknown>, timeoutMs = 15_000): Promise<PiFrame> {
    if (this.#child.exitCode !== null) throw new Error("Pi process is not running");
    const id = randomUUID();
    const admission = new PiResponseAdmission();
    const response = new Promise<PiFrame>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        if (admission.state === "admitted_pending_commit") {
          this.#failStdout(new PiResponseCommitDelayError());
          return;
        }
        this.#responses.delete(id);
        admission.fail();
        rejectResponse(new Error("Pi RPC request timed out"));
      }, timeoutMs);
      this.#responses.set(id, {
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
        admission,
      });
    });
    try {
      await this.#write({ ...command, id });
    } catch (error: unknown) {
      const waiter = this.#responses.get(id);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#responses.delete(id);
        waiter.admission.fail();
        waiter.reject(error instanceof Error ? error : new Error("Pi RPC write failed"));
      }
    }
    const frame = await response;
    if (frame.success !== true) {
      throw new PiRpcRejectedError(frame.error ?? `Pi rejected ${String(command.type)}`);
    }
    return frame;
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      if (!(await this.#waitForExit(1_000))) {
        throw new Error(`Pi process group ${String(this.pid)} is still running`);
      }
      return;
    }
    this.#stopping = true;
    if (this.#child.exitCode === null) this.#child.stdin.end();
    if (await this.#waitForExit(500)) return;
    signalProcessTree(this.pid, "SIGTERM");
    if (await this.#waitForExit(1_000)) return;
    signalProcessTree(this.pid, "SIGKILL");
    if (!(await this.#waitForExit(1_000))) {
      throw new Error(`Pi process group ${String(this.pid)} did not exit after SIGKILL`);
    }
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (!(await waitForProcessGroupExit(this.pid, timeoutMs))) return false;
    await this.#exitHandled;
    return true;
  }

  async #write(frame: PiFrame): Promise<void> {
    if (this.#child.stdin.write(`${JSON.stringify(frame)}\n`)) return;
    await once(this.#child.stdin, "drain");
  }

  async #consumeStdout(chunk: Buffer): Promise<void> {
    for (const record of this.#stdoutFramer.push(chunk)) {
      const commit = this.#onStdoutRecord(record);
      if (record.length - 1 > this.#maxStdoutFrameBytes) {
        await commit;
        throw new Error("Pi RPC record exceeds the configured parser limit");
      }
      let lineBytes = record.subarray(0, record.length - 1);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      let frame: PiFrame | null = null;
      if (lineBytes.length > 0) {
        try {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
          frame = JSON.parse(line) as PiFrame;
        } catch {
          await commit;
          throw new Error("Pi emitted a malformed RPC record");
        }
      }
      const waiter =
        frame?.type === "response" && typeof frame.id === "string"
          ? this.#responses.get(frame.id)
          : undefined;
      if (waiter !== undefined) waiter.admission.admit();
      await commit;
      if (waiter !== undefined) {
        if (waiter.admission.state !== "admitted_pending_commit") continue;
        waiter.admission.commit();
        clearTimeout(waiter.timer);
        this.#responses.delete(frame!.id!);
        waiter.resolve(frame!);
      }
      if (frame === null) continue;
      if (
        frame.type === "extension_ui_request" &&
        typeof frame.id === "string" &&
        ["select", "confirm", "input", "editor"].includes(String(frame.method))
      ) {
        void this.#write({ type: "extension_ui_response", id: frame.id, cancelled: true }).catch(
          () => undefined,
        );
      }
      for (const listener of this.#listeners) listener(frame);
    }
  }

  async drainStdout(): Promise<void> {
    await this.#stdoutLane;
  }

  #failStdout(error: unknown): void {
    if (this.#stdoutFailure !== null) return;
    this.#stdoutFailure =
      error instanceof Error ? error : new Error("Pi stdout persistence failed");
    for (const waiter of this.#responses.values()) {
      clearTimeout(waiter.timer);
      if (waiter.admission.state !== "committed") waiter.admission.fail();
      waiter.reject(this.#stdoutFailure);
    }
    this.#responses.clear();
    signalProcessTree(this.pid, "SIGTERM");
  }

  async #handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): Promise<void> {
    if (this.#handledExit) return;
    this.#handledExit = true;
    await this.#stdoutLane.catch(() => undefined);
    const trailingPartial = this.#stdoutFramer.finish();
    const error =
      this.#stdoutFailure ??
      (trailingPartial !== null
        ? new Error("Pi exited with an unterminated RPC record")
        : this.#stopping && (code === 0 || signal === "SIGTERM")
          ? null
          : (cause ??
            new Error(`Pi exited unexpectedly (code=${String(code)}, signal=${String(signal)})`)));
    try {
      for (const waiter of this.#responses.values()) {
        clearTimeout(waiter.timer);
        if (waiter.admission.state !== "committed") waiter.admission.fail();
        waiter.reject(error ?? new Error("Pi stopped before responding"));
      }
      this.#responses.clear();
      for (const listener of this.#exitListeners) listener(error);
    } finally {
      this.#resolveExitHandled();
    }
  }
}
