import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { readJsonLines, writeJsonLine } from "../protocol/jsonl.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import { err, ok, type Result } from "../shared/result.js";
import type {
  CreateInput,
  CreateResult,
  DestroyInput,
  DestroyResult,
  FleetClient,
  FleetClientError,
  ListResult,
  MutationOptions,
  RawSessionChunk,
  ReceiveInput,
  ReceiveResult,
  RequestOptions,
  SendInput,
  SendResult,
  StatusInput,
  StatusResult,
  WatchInput,
} from "./fleet-client.js";

export class SocketFleetClient implements FleetClient {
  constructor(
    private readonly options: {
      readonly socketPath: string;
      readonly beforeConnect?: () => Promise<void>;
    },
  ) {}

  create(
    input: CreateInput,
    options: MutationOptions,
  ): Promise<Result<CreateResult, FleetClientError>> {
    return this.#request("agent.create", input, options);
  }

  send(input: SendInput, options: MutationOptions): Promise<Result<SendResult, FleetClientError>> {
    return this.#request("agent.send", input, options);
  }

  receive(
    input: ReceiveInput,
    options: RequestOptions,
  ): Promise<Result<ReceiveResult, FleetClientError>> {
    return this.#request("agent.receive", { ...input, timeoutMs: options.timeoutMs }, options);
  }

  status(
    input: StatusInput,
    options: RequestOptions,
  ): Promise<Result<StatusResult, FleetClientError>> {
    return this.#request("agent.status", input, options);
  }

  list(options: RequestOptions): Promise<Result<ListResult, FleetClientError>> {
    return this.#request("agent.list", {}, options);
  }

  async *watchSession(
    input: WatchInput,
    options: RequestOptions,
  ): AsyncIterable<Result<RawSessionChunk, FleetClientError>> {
    let socket: Socket;
    try {
      await this.options.beforeConnect?.();
      socket = await connect(this.options.socketPath, options.signal);
    } catch (error: unknown) {
      yield err(connectionError(error));
      return;
    }

    const requestId = randomUUID();
    const frames = frameIterator(socket, options.signal);
    writeJsonLine(socket, {
      v: PROTOCOL_VERSION,
      requestId,
      method: "agent.watch",
      params: input,
    });

    let endedExplicitly = false;
    try {
      for await (const frame of frames) {
        if (!isRecord(frame) || frame.requestId !== requestId) continue;
        if (frame.v !== PROTOCOL_VERSION) {
          yield err({
            code: "protocol_error",
            message: "Runtime protocol version is incompatible with this client.",
          });
          return;
        }
        if (frame.stream === "ready") continue;
        if (frame.stream === "end") {
          endedExplicitly = true;
          return;
        }
        if (frame.stream === "chunk" && typeof frame.data === "string") {
          yield ok({ bytes: Buffer.from(frame.data, "base64") });
          continue;
        }
        if (frame.stream === "error" && isErrorRecord(frame.error)) {
          yield err(frame.error);
          return;
        }
        yield err({ code: "protocol_error", message: "Invalid watch stream frame." });
        return;
      }
      if (!endedExplicitly && !options.signal.aborted) {
        yield err({
          code: "runtime_unavailable",
          message: "Runtime connection closed before the watch stream ended.",
        });
      }
    } catch (error: unknown) {
      if (!options.signal.aborted) yield err(connectionError(error));
    } finally {
      socket.destroy();
    }
  }

  destroy(
    input: DestroyInput,
    options: MutationOptions,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    return this.#request("agent.destroy", input, options);
  }

  async #request<T>(
    method: string,
    params: object,
    options: RequestOptions | MutationOptions,
  ): Promise<Result<T, FleetClientError>> {
    let socket: Socket;
    try {
      await this.options.beforeConnect?.();
      socket = await connect(this.options.socketPath, options.signal);
    } catch (error: unknown) {
      return err(connectionError(error));
    }

    const requestId = randomUUID();
    const response = firstMatchingFrame(socket, requestId, options.signal);
    writeJsonLine(socket, {
      v: PROTOCOL_VERSION,
      requestId,
      method,
      params,
      ...(isMutationOptions(options) ? { operation: options.operation } : {}),
    });

    try {
      const frame = await response;
      if (!isRecord(frame) || frame.requestId !== requestId || typeof frame.ok !== "boolean") {
        return err({ code: "protocol_error", message: "Invalid runtime response." });
      }
      if (frame.v !== PROTOCOL_VERSION) {
        return err({
          code: "protocol_error",
          message: "Runtime protocol version is incompatible with this client.",
        });
      }
      if (frame.ok) return ok(frame.result as T);
      if (isErrorRecord(frame.error)) return err(frame.error);
      return err({ code: "protocol_error", message: "Runtime returned an invalid error." });
    } catch (error: unknown) {
      return err(connectionError(error));
    } finally {
      socket.destroy();
    }
  }
}

function isMutationOptions(options: RequestOptions | MutationOptions): options is MutationOptions {
  return "operation" in options;
}

function connect(socketPath: string, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolveConnect, rejectConnect) => {
    if (signal.aborted) {
      rejectConnect(new Error("Request cancelled"));
      return;
    }
    const socket = createConnection(socketPath);
    const onAbort = () => socket.destroy(new Error("Request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      resolveConnect(socket);
    });
    socket.once("error", rejectConnect);
  });
}

function firstMatchingFrame(
  socket: Socket,
  requestId: string,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolveFrame, rejectFrame) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      stop();
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const stop = readJsonLines(
      socket,
      (frame) => {
        if (!isRecord(frame) || frame.requestId !== requestId) return;
        finish(() => resolveFrame(frame));
      },
      (error) => finish(() => rejectFrame(error)),
    );
    const onAbort = () => finish(() => rejectFrame(new Error("Request cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () =>
      finish(() => rejectFrame(new Error("Runtime connection closed before responding"))),
    );
  });
}

export async function* frameIterator(
  socket: Socket,
  signal: AbortSignal,
  maxQueuedBytes = 1024 * 1024,
): AsyncIterable<unknown> {
  const queue: { readonly value: unknown; readonly bytes: number }[] = [];
  let queuedBytes = 0;
  let paused = false;
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const stop = readJsonLines(
    socket,
    (frame) => {
      const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
      queue.push({ value: frame, bytes });
      queuedBytes += bytes;
      if (queuedBytes >= maxQueuedBytes && !paused) {
        socket.pause();
        paused = true;
      }
      notify();
    },
    (error) => {
      failure = error;
      ended = true;
      notify();
    },
  );
  socket.once("end", () => {
    failure = new Error("Runtime connection closed before completing the stream");
    ended = true;
    notify();
  });
  const onAbort = () => {
    failure = new Error("Request cancelled");
    ended = true;
    notify();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
        });
        continue;
      }
      const item = queue.shift();
      if (item === undefined) continue;
      queuedBytes -= item.bytes;
      if (paused && queuedBytes < maxQueuedBytes / 2) {
        socket.resume();
        paused = false;
      }
      yield item.value;
    }
    if (failure !== null) throw failure;
  } finally {
    stop();
    signal.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorRecord(value: unknown): value is FleetClientError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function connectionError(error: unknown): FleetClientError {
  return {
    code: "runtime_unavailable",
    message: error instanceof Error ? error.message : "Unable to connect to Pi Fleet runtime.",
  };
}
