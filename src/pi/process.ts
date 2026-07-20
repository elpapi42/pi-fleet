import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { signalProcessTree } from "../platform/runtime/process-tree.js";

const DEFAULT_MAX_STDOUT_FRAME_BYTES = 8 * 1024 * 1024;

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

export interface PiProcessStartOptions {
  readonly executable: string;
  readonly argvPrefix?: readonly string[];
  readonly piArgv: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxStdoutFrameBytes?: number;
}

interface ResponseWaiter {
  readonly resolve: (frame: PiFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #responses = new Map<string, ResponseWaiter>();
  readonly #listeners = new Set<(frame: PiFrame) => void>();
  readonly #exitListeners = new Set<(error: Error | null) => void>();
  #stdoutBuffer = "";
  #stderr = "";
  #stopping = false;
  readonly #maxStdoutFrameBytes: number;

  private constructor(options: PiProcessStartOptions) {
    this.#maxStdoutFrameBytes = options.maxStdoutFrameBytes ?? DEFAULT_MAX_STDOUT_FRAME_BYTES;
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
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#consumeStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-65_536);
    });
    this.#child.once("exit", (code, signal) => this.#handleExit(code, signal));
    this.#child.once("error", (error) => this.#handleExit(null, null, error));
  }

  static async start(options: PiProcessStartOptions): Promise<PiProcess> {
    const process = new PiProcess(options);
    try {
      await process.getState();
      return process;
    } catch (error: unknown) {
      await process.stop().catch(() => undefined);
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

  async getLastAssistantText(): Promise<string | null> {
    const frame = await this.request({ type: "get_last_assistant_text" });
    return typeof frame.data?.text === "string" ? frame.data.text : null;
  }

  async request(command: Record<string, unknown>, timeoutMs = 15_000): Promise<PiFrame> {
    if (this.#child.exitCode !== null) throw new Error("Pi process is not running");
    const id = randomUUID();
    const response = new Promise<PiFrame>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.#responses.delete(id);
        rejectResponse(new Error(`Pi RPC request timed out. stderr: ${this.#stderr}`));
      }, timeoutMs);
      this.#responses.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
    });
    await this.#write({ ...command, id });
    const frame = await response;
    if (frame.success !== true)
      throw new Error(frame.error ?? `Pi rejected ${String(command.type)}`);
    return frame;
  }

  async stop(): Promise<void> {
    if (this.#stopping || this.#child.exitCode !== null) return;
    this.#stopping = true;
    this.#child.stdin.end();
    if (await this.#waitForExit(500)) return;
    signalProcessTree(this.pid, "SIGTERM");
    if (await this.#waitForExit(1_000)) return;
    signalProcessTree(this.pid, "SIGKILL");
    if (!(await this.#waitForExit(1_000))) {
      throw new Error(`Pi process group ${String(this.pid)} did not exit after SIGKILL`);
    }
  }

  async #write(frame: PiFrame): Promise<void> {
    if (this.#child.stdin.write(`${JSON.stringify(frame)}\n`)) return;
    await once(this.#child.stdin, "drain");
  }

  #consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#stdoutBuffer) > this.#maxStdoutFrameBytes) {
          signalProcessTree(this.pid, "SIGTERM");
        }
        return;
      }
      if (Buffer.byteLength(this.#stdoutBuffer.slice(0, newline)) > this.#maxStdoutFrameBytes) {
        signalProcessTree(this.pid, "SIGTERM");
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let frame: PiFrame;
      try {
        frame = JSON.parse(line) as PiFrame;
      } catch {
        this.#child.kill("SIGTERM");
        return;
      }
      if (
        frame.type === "extension_ui_request" &&
        typeof frame.id === "string" &&
        ["select", "confirm", "input", "editor"].includes(String(frame.method))
      ) {
        void this.#write({ type: "extension_ui_response", id: frame.id, cancelled: true }).catch(
          () => undefined,
        );
      }
      if (frame.type === "response" && frame.id !== undefined) {
        const waiter = this.#responses.get(frame.id);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          this.#responses.delete(frame.id);
          waiter.resolve(frame);
        }
      }
      for (const listener of this.#listeners) listener(frame);
    }
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#child.exitCode !== null) return true;
    return Promise.race([
      once(this.#child, "exit").then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
    ]);
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null, cause?: Error): void {
    const error =
      this.#stopping && (code === 0 || signal === "SIGTERM")
        ? null
        : (cause ??
          new Error(`Pi exited unexpectedly (code=${String(code)}, signal=${String(signal)})`));
    for (const waiter of this.#responses.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error("Pi stopped before responding"));
    }
    this.#responses.clear();
    for (const listener of this.#exitListeners) listener(error);
  }
}
