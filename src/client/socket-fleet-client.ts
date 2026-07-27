import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { readJsonLines, writeJsonLine } from "../protocol/jsonl.js";
import { MANAGED_PI_RUNTIME_IDENTITY, type PiRuntimeIdentity } from "../protocol/pi-identity.js";
import {
  SemanticEventReassembler,
  type SemanticSegmentFrame,
} from "../protocol/semantic-segmentation.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import { isPiFleetErrorCode } from "./contracts.js";
import type { ReceiveCursor } from "./contracts.js";
import { err, ok, type Result } from "../shared/result.js";
import type {
  CompactInput,
  CompactResult,
  CreateInput,
  CreateResult,
  DestroyInput,
  DestroyResult,
  FleetClient,
  FleetClientError,
  ListResult,
  MutationOptions,
  ReceiveInput,
  ReceiveStreamItem,
  RequestOptions,
  SendInput,
  SendResult,
  StatusInput,
  StatusResult,
} from "./fleet-client.js";

export class SocketFleetClient implements FleetClient {
  constructor(
    private readonly options: {
      readonly socketPath: string;
      readonly beforeConnect?: () => Promise<void>;
      readonly piIdentity?: PiRuntimeIdentity | (() => Promise<PiRuntimeIdentity>);
    },
  ) {}

  create(
    input: CreateInput,
    options: MutationOptions,
  ): Promise<Result<CreateResult, FleetClientError>> {
    return this.#request("agent.create", input, options);
  }

  async send(
    input: SendInput,
    options: MutationOptions,
  ): Promise<Result<SendResult, FleetClientError>> {
    const bound = await this.#bind(input, options);
    if (!bound.ok) return bound;
    return this.#request("agent.send", bound.value, options);
  }

  async *receive(
    input: ReceiveInput,
    options: RequestOptions,
  ): AsyncIterable<Result<ReceiveStreamItem, FleetClientError>> {
    const bound = await this.#bind(input, options);
    if (!bound.ok) {
      yield bound;
      return;
    }
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
    let reassembler: SemanticEventReassembler | null = null;
    let expectedCursor: ReceiveCursor | null = null;
    writeJsonLine(socket, {
      v: PROTOCOL_VERSION,
      requestId,
      method: "agent.receive",
      params: receiveParams(bound.value),
    });
    let ready = false;
    let ended = false;
    try {
      for await (const frame of frames) {
        if (!isRecord(frame) || frame.requestId !== requestId) continue;
        if (frame.v !== PROTOCOL_VERSION) {
          yield err(protocolIncompatible());
          return;
        }
        if (frame.stream === "ready" && typeof frame.cursor === "string") {
          if (
            ready ||
            !isRecord(frame.limits) ||
            !isPositiveSafeInteger(frame.limits.maxEventBytes) ||
            !isPositiveSafeInteger(frame.limits.maxSegments)
          ) {
            yield err({ code: "protocol_error", message: "Invalid receive readiness frame." });
            return;
          }
          ready = true;
          expectedCursor = frame.cursor as ReceiveCursor;
          reassembler = new SemanticEventReassembler(
            frame.limits.maxEventBytes,
            frame.limits.maxSegments,
          );
          yield ok({ type: "ready", cursor: expectedCursor });
          continue;
        }
        if (frame.stream === "semantic.segment" && isSemanticSegment(frame.segment)) {
          if (!ready) {
            yield err({
              code: "protocol_error",
              message: "Receive event arrived before readiness.",
            });
            return;
          }
          try {
            if (reassembler === null || expectedCursor === null) {
              throw new Error("Receive stream is not ready");
            }
            const complete = reassembler.push(frame.segment);
            if (complete !== null) {
              if (complete.precedingCursor !== expectedCursor) {
                throw new Error("Receive event cursor chain is discontinuous");
              }
              expectedCursor = complete.event.cursor;
              yield ok({ type: "event", cursor: complete.event.cursor, event: complete.event });
            }
          } catch {
            yield err({ code: "protocol_error", message: "Receive stream segmentation failed." });
            return;
          }
          continue;
        }
        if (frame.stream === "end") {
          ended = true;
          return;
        }
        if (frame.stream === "error" && isErrorRecord(frame.error)) {
          yield err(frame.error);
          return;
        }
        yield err({ code: "protocol_error", message: "Invalid receive stream frame." });
        return;
      }
      if (!ended && !options.signal.aborted) {
        yield err({
          code: "runtime_unavailable",
          message: "Runtime connection closed before the receive stream ended.",
        });
      }
    } catch (error: unknown) {
      if (!options.signal.aborted) yield err(connectionError(error));
    } finally {
      socket.destroy();
    }
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

  async destroy(
    input: DestroyInput,
    options: MutationOptions,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    const bound = await this.#bind(input, options);
    if (!bound.ok) return bound;
    return this.#request("agent.destroy", bound.value, options);
  }

  async compact(
    input: CompactInput,
    options: MutationOptions,
  ): Promise<Result<CompactResult, FleetClientError>> {
    const bound = await this.#bind(input, options);
    if (!bound.ok) return bound;
    return this.#request("agent.compact", bound.value, options);
  }

  async #bind<T extends { readonly name: string; readonly expectedAgentId?: string }>(
    input: T,
    options: RequestOptions,
  ): Promise<Result<T & { readonly expectedAgentId: string }, FleetClientError>> {
    if (input.expectedAgentId !== undefined) {
      return ok({ ...input, expectedAgentId: input.expectedAgentId });
    }
    const status = await this.status(
      { name: input.name },
      {
        signal: options.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    );
    if (!status.ok) return status;
    return ok({ ...input, expectedAgentId: status.value.agent.id });
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
    let piIdentity: PiRuntimeIdentity | undefined;
    try {
      piIdentity = requiresPiIdentity(method) ? await this.#piIdentity() : undefined;
    } catch (error: unknown) {
      socket.destroy();
      return err(piSelectionError(error));
    }
    const response = firstMatchingFrame(socket, requestId, options.signal);
    writeJsonLine(socket, {
      v: PROTOCOL_VERSION,
      requestId,
      method,
      params,
      ...(isMutationOptions(options) ? { operation: options.operation } : {}),
      ...(piIdentity === undefined ? {} : { runtime: { pi: piIdentity } }),
    });
    try {
      const frame = await response;
      if (!isRecord(frame) || frame.requestId !== requestId || typeof frame.ok !== "boolean") {
        return err({ code: "protocol_error", message: "Invalid runtime response." });
      }
      if (frame.v !== PROTOCOL_VERSION) return err(protocolIncompatible());
      if (frame.ok) return ok(frame.result as T);
      if (isErrorRecord(frame.error)) return err(frame.error);
      return err({ code: "protocol_error", message: "Runtime returned an invalid error." });
    } catch (error: unknown) {
      return err(connectionError(error));
    } finally {
      socket.destroy();
    }
  }

  async #piIdentity(): Promise<PiRuntimeIdentity> {
    const configured = this.options.piIdentity;
    if (configured === undefined) return MANAGED_PI_RUNTIME_IDENTITY;
    return typeof configured === "function" ? configured() : configured;
  }
}

function receiveParams(input: ReceiveInput): Record<string, unknown> {
  const start = input.start ?? { kind: "live" };
  return {
    name: input.name,
    ...(input.expectedAgentId === undefined ? {} : { expectedAgentId: input.expectedAgentId }),
    ...(start.kind === "after" ? { after: start.cursor } : {}),
    ...(start.kind === "start" ? { fromStart: true } : {}),
    ...(input.untilIdle === true ? { untilIdle: true } : {}),
  };
}

function protocolIncompatible(): FleetClientError {
  return {
    code: "protocol_incompatible",
    message: "The running pi-fleet runtime is incompatible with this client; repair or restart it.",
  };
}

function piSelectionError(error: unknown): FleetClientError {
  const code = (error as { code?: unknown }).code;
  if (
    code === "pi_not_found" ||
    code === "pi_not_executable" ||
    code === "pi_version_unavailable" ||
    code === "pi_version_unsupported" ||
    code === "pi_installation_changed" ||
    code === "pi_service_mismatch"
  ) {
    return { code, message: error instanceof Error ? error.message : "Pi is unavailable." };
  }
  return { code: "internal_error", message: "Pi selection failed." };
}

function isMutationOptions(options: RequestOptions | MutationOptions): options is MutationOptions {
  return "operation" in options;
}

function requiresPiIdentity(method: string): boolean {
  return method === "agent.create" || method === "agent.send" || method === "agent.compact";
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
      const bytes = Buffer.byteLength(JSON.stringify(frame));
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

function isSemanticSegment(value: unknown): value is SemanticSegmentFrame {
  return isRecord(value) && value.type === "semantic.segment";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isErrorRecord(value: unknown): value is FleetClientError {
  return (
    isRecord(value) &&
    isPiFleetErrorCode(value.code) &&
    typeof value.message === "string" &&
    isSafeErrorDetails(value.code, value.details)
  );
}

/**
 * Terminal receive-stream failures may report the last durably delivered
 * position so a caller can resume deliberately. Only continuity uncertainty may
 * additionally offer an explicit continuation cursor.
 */
function isSafeErrorDetails(
  code: string,
  details: unknown,
): details is Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) return true;
  if (!isRecord(details)) return false;
  const allowed =
    code === "observation_uncertain"
      ? ["lastSafeCursor", "continuationCursor"]
      : ["lastSafeCursor"];
  if (Object.keys(details).some((key) => !allowed.includes(key))) return false;
  if (!(typeof details.lastSafeCursor === "string" || details.lastSafeCursor === undefined)) {
    return false;
  }
  if (code !== "observation_uncertain") return true;
  return typeof details.continuationCursor === "string" || details.continuationCursor === null;
}

function connectionError(error: unknown): FleetClientError {
  void error;
  return {
    code: "runtime_unavailable",
    message: "Unable to connect to pi-fleet runtime.",
  };
}
