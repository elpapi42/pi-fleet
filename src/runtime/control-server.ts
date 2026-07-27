import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type {
  CompactInput,
  CreateInput,
  DestroyInput,
  FleetClientError,
  ReceiveInput,
  SendInput,
  StatusInput,
} from "../client/fleet-client.js";
import type { ReceiveStart } from "../client/agent-target.js";
import { parseProtocolRequest } from "../protocol/validation.js";
import { writeJsonLine, readJsonLines } from "../protocol/jsonl.js";
import type { PiRuntimeIdentity } from "../protocol/pi-identity.js";
import { segmentSemanticEvent } from "../protocol/semantic-segmentation.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../shared/runtime-limits.js";
import type { Result } from "../shared/result.js";
import type { FleetService } from "./fleet-service.js";
import type { JournalRuntimeComposition } from "./journal-runtime.js";
import { ReceiveObservationUncertainError } from "./receive-pager.js";
import type { ReceiveCursor, SemanticEvent } from "./semantic-events.js";
import {
  inspectControlSocketOwnership,
  RuntimeOwnershipBlockedError,
} from "../platform/shared/runtime-ownership.js";

export interface ControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface ControlLimits {
  readonly maxProtocolFrameBytes: number;
  readonly maxSemanticFrameBytes: number;
  readonly maxSemanticSegments: number;
  readonly maxSemanticEventBytes: number;
  readonly maxSocketWriteMs: number;
}

export async function startControlServer(options: {
  readonly socketPath: string;
  readonly service: FleetService | Promise<FleetService>;
  readonly journal?: () => Promise<JournalRuntimeComposition>;
  readonly limits?: Partial<
    Pick<
      RuntimeLimits,
      | "maxProtocolFrameBytes"
      | "maxSemanticFrameBytes"
      | "maxSemanticSegments"
      | "maxPiFrameBytes"
      | "maxSocketWriteMs"
    >
  >;
}): Promise<ControlServer> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await prepareSocketPath(options.socketPath);
  const service = Promise.resolve(options.service);
  const limits = {
    maxProtocolFrameBytes:
      options.limits?.maxProtocolFrameBytes ?? DEFAULT_RUNTIME_LIMITS.maxProtocolFrameBytes,
    maxSemanticFrameBytes:
      options.limits?.maxSemanticFrameBytes ?? DEFAULT_RUNTIME_LIMITS.maxSemanticFrameBytes,
    maxSemanticSegments:
      options.limits?.maxSemanticSegments ?? DEFAULT_RUNTIME_LIMITS.maxSemanticSegments,
    maxSemanticEventBytes:
      options.limits?.maxPiFrameBytes ?? DEFAULT_RUNTIME_LIMITS.maxPiFrameBytes,
    maxSocketWriteMs: options.limits?.maxSocketWriteMs ?? DEFAULT_RUNTIME_LIMITS.maxSocketWriteMs,
  };
  const server = createServer((socket) =>
    handleConnection(
      socket,
      service,
      options.journal ?? (() => Promise.reject(new Error("Semantic receive is unavailable"))),
      limits,
    ),
  );
  server.listen(options.socketPath);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("listening", resolveListen);
    server.once("error", rejectListen);
  });
  await chmod(options.socketPath, 0o600);
  return {
    socketPath: options.socketPath,
    async close() {
      await closeServer(server);
      await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

function handleConnection(
  socket: Socket,
  service: Promise<FleetService>,
  journal: () => Promise<JournalRuntimeComposition>,
  limits: ControlLimits,
): void {
  let handled = false;
  const abort = new AbortController();
  socket.once("close", () => abort.abort());
  const stopReading = readJsonLines(
    socket,
    (value) => {
      if (handled) return;
      handled = true;
      stopReading();
      void service
        .then((readyService) =>
          dispatch(value, readyService, journal, socket, abort.signal, limits),
        )
        .catch((error: unknown) => writeConnectionError(socket, value, error));
    },
    (error) => writeConnectionError(socket, undefined, new InvalidRequestError(error.message)),
    limits.maxProtocolFrameBytes,
  );
}

async function dispatch(
  value: unknown,
  service: FleetService,
  journal: () => Promise<JournalRuntimeComposition>,
  socket: Socket,
  connectionSignal: AbortSignal,
  limits: ControlLimits,
): Promise<void> {
  let request: ReturnType<typeof parseProtocolRequest>;
  try {
    request = parseProtocolRequest(value);
  } catch (error: unknown) {
    throw new InvalidRequestError(
      error instanceof Error ? error.message : "Invalid protocol request",
    );
  }
  const operationId = request.operation?.operationId;
  let result: Result<unknown, FleetClientError>;
  switch (request.method) {
    case "agent.create":
      result = await service.create(
        asCreateInput(request.params),
        requireOperation(operationId),
        requirePiIdentity(request.runtime?.pi),
      );
      break;
    case "agent.send":
      result = await service.send(
        asSendInput(request.params),
        requireOperation(operationId),
        requirePiIdentity(request.runtime?.pi),
      );
      break;
    case "agent.receive":
      await streamReceive(
        request.requestId,
        asReceiveInput(request.params),
        service,
        await journal(),
        socket,
        connectionSignal,
        limits,
      );
      return;
    case "agent.status":
      result = await service.status(asNamedInput(request.params));
      break;
    case "agent.list":
      result = await service.list();
      break;
    case "agent.destroy":
      result = await service.destroy(asBoundInput(request.params), requireOperation(operationId));
      break;
    case "agent.compact":
      result = await service.compact(
        asBoundInput(request.params),
        requireOperation(operationId),
        requirePiIdentity(request.runtime?.pi),
      );
      break;
  }
  await writeFrame(
    socket,
    result.ok
      ? { v: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: result.value }
      : { v: PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: result.error },
    limits.maxSocketWriteMs,
  );
  socket.end();
}

async function streamReceive(
  requestId: string,
  input: ReceiveInput,
  service: FleetService,
  journal: JournalRuntimeComposition,
  socket: Socket,
  connectionSignal: AbortSignal,
  limits: ControlLimits,
): Promise<void> {
  const abort = new AbortController();
  const onConnectionAbort = () => abort.abort(connectionSignal.reason);
  connectionSignal.addEventListener("abort", onConnectionAbort, { once: true });
  let lastCursor: ReceiveCursor | null = null;
  try {
    const prepared = await service.prepareReceive(
      input,
      input.start ?? { kind: "live" },
      input.untilIdle === true,
      abort.signal,
    );
    if (!prepared.ok) {
      await writeStreamError(socket, requestId, prepared.error, limits.maxSocketWriteMs);
      return;
    }
    const { stream, idle } = prepared.value;
    await writeFrame(
      socket,
      {
        v: PROTOCOL_VERSION,
        requestId,
        stream: "ready",
        cursor: stream.cursor,
        limits: {
          maxEventBytes: limits.maxSemanticEventBytes,
          maxSegments: limits.maxSemanticSegments,
        },
      },
      limits.maxSocketWriteMs,
      limits.maxProtocolFrameBytes,
    );

    const iterator = stream[Symbol.asyncIterator]();
    let precedingCursor = stream.cursor;
    lastCursor = stream.cursor;
    let lastPosition = journal.decodeCursorPosition(stream.cursor);
    let idleHighWater: number | null = null;
    let pending = iterator.next();
    while (!abort.signal.aborted) {
      if (idle !== null && idleHighWater === null) {
        const raced = await Promise.race([
          pending.then((next) => ({ kind: "event" as const, next })),
          idle.then((settled) => ({ kind: "idle" as const, settled })),
        ]);
        if (raced.kind === "idle") {
          if (!raced.settled.ok) {
            await writeStreamError(socket, requestId, raced.settled.error, limits.maxSocketWriteMs);
            return;
          }
          idleHighWater = raced.settled.value.idleEventPosition;
          if (lastPosition >= idleHighWater) break;
          continue;
        }
        if (raced.next.done) break;
        const event = raced.next.value;
        await writeSemanticEvent(socket, requestId, event, precedingCursor, limits);
        precedingCursor = event.cursor;
        lastCursor = event.cursor;
        lastPosition = journal.decodeCursorPosition(event.cursor);
        pending = iterator.next();
        continue;
      }

      if (idleHighWater !== null && lastPosition >= idleHighWater) break;
      const next = await pending;
      if (next.done) break;
      const event = next.value;
      await writeSemanticEvent(socket, requestId, event, precedingCursor, limits);
      precedingCursor = event.cursor;
      lastCursor = event.cursor;
      lastPosition = journal.decodeCursorPosition(event.cursor);
      pending = iterator.next();
    }
    abort.abort();
    await pending.catch(() => ({ done: true as const, value: undefined }));
    await iterator.return?.();
    if (!socket.destroyed) {
      await writeFrame(
        socket,
        { v: PROTOCOL_VERSION, requestId, stream: "end" },
        limits.maxSocketWriteMs,
      );
      socket.end();
    }
  } catch (error: unknown) {
    if (socket.destroyed || connectionSignal.aborted) return;
    const failure =
      error instanceof ReceiveObservationUncertainError
        ? {
            code: error.code,
            message: error.message,
            details: {
              lastSafeCursor: error.lastSafeCursor,
              continuationCursor: error.continuationCursor,
            },
          }
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? {
              code: error.code,
              message: "Receive stream failed.",
              ...(lastCursor === null ? {} : { details: { lastSafeCursor: lastCursor } }),
            }
          : error instanceof Error && error.message.startsWith("Semantic")
            ? {
                code: "semantic_event_too_large",
                message: "A semantic event exceeds stream limits.",
              }
            : { code: "internal_error", message: "Receive stream failed." };
    await writeStreamError(socket, requestId, failure, limits.maxSocketWriteMs);
  } finally {
    connectionSignal.removeEventListener("abort", onConnectionAbort);
  }
}

async function writeSemanticEvent(
  socket: Socket,
  requestId: string,
  event: SemanticEvent,
  precedingCursor: ReceiveCursor,
  limits: ControlLimits,
): Promise<void> {
  let segmentLimit = Math.max(
    1,
    Math.min(limits.maxSemanticFrameBytes, limits.maxProtocolFrameBytes),
  );
  let frames: unknown[] | null = null;
  while (frames === null) {
    const candidates = segmentSemanticEvent(
      event,
      precedingCursor,
      segmentLimit,
      limits.maxSemanticSegments,
    ).map((segment) => ({
      v: PROTOCOL_VERSION,
      requestId,
      stream: "semantic.segment",
      segment,
    }));
    if (
      candidates.every(
        (frame) => Buffer.byteLength(JSON.stringify(frame)) + 1 <= limits.maxProtocolFrameBytes,
      )
    ) {
      frames = candidates;
      break;
    }
    if (segmentLimit === 1) {
      throw new Error("Semantic event envelope exceeds the configured protocol limit");
    }
    segmentLimit = Math.max(1, Math.floor(segmentLimit * 0.75));
  }
  for (const frame of frames) {
    await writeFrame(socket, frame, limits.maxSocketWriteMs, limits.maxProtocolFrameBytes);
  }
}

function asCreateInput(params: Record<string, unknown>): CreateInput {
  const name = stringParam(params, "name");
  const cwd = stringParam(params, "cwd");
  const instructions = params.instructions;
  const piArgv = params.piArgv;
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new InvalidRequestError("instructions must be a string");
  }
  if (!Array.isArray(piArgv) || !piArgv.every((token) => typeof token === "string")) {
    throw new InvalidRequestError("piArgv must be an array of strings");
  }
  return { name, cwd, piArgv, ...(instructions === undefined ? {} : { instructions }) };
}

function asSendInput(params: Record<string, unknown>): SendInput {
  const delivery = params.delivery;
  if (delivery !== undefined && delivery !== "steer" && delivery !== "followUp") {
    throw new InvalidRequestError("delivery must be steer or followUp");
  }
  return {
    ...asBoundInput(params),
    message: stringParam(params, "message"),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

function asReceiveInput(params: Record<string, unknown>): ReceiveInput {
  const named = asBoundInput(params);
  if (params.untilIdle !== undefined && typeof params.untilIdle !== "boolean") {
    throw new InvalidRequestError("untilIdle must be a boolean");
  }
  const start = receiveStart(params);
  if (params.untilIdle === true && start.kind !== "live") {
    throw new InvalidRequestError("untilIdle uses a live boundary and cannot include history");
  }
  return {
    ...named,
    start,
    ...(params.untilIdle === true ? { untilIdle: true } : {}),
  };
}

function receiveStart(params: Record<string, unknown>): ReceiveStart {
  if (params.fromStart !== undefined && typeof params.fromStart !== "boolean") {
    throw new InvalidRequestError("fromStart must be a boolean");
  }
  if (params.after !== undefined && typeof params.after !== "string") {
    throw new InvalidRequestError("after must be a string cursor");
  }
  if (params.fromStart === true && params.after !== undefined) {
    throw new InvalidRequestError("after and fromStart cannot be combined");
  }
  if (params.fromStart === true) return { kind: "start" };
  if (typeof params.after === "string") {
    return { kind: "after", cursor: params.after as ReceiveCursor };
  }
  return { kind: "live" };
}

function asNamedInput(params: Record<string, unknown>): StatusInput & DestroyInput & CompactInput {
  const expectedAgentId = params.expectedAgentId;
  if (expectedAgentId !== undefined && typeof expectedAgentId !== "string") {
    throw new InvalidRequestError("expectedAgentId must be a string");
  }
  return {
    name: stringParam(params, "name"),
    ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
  };
}

function asBoundInput(
  params: Record<string, unknown>,
): StatusInput & DestroyInput & CompactInput & { readonly expectedAgentId: string } {
  const input = asNamedInput(params);
  if (input.expectedAgentId === undefined) {
    throw new InvalidRequestError("expectedAgentId is required for agent-scoped operations");
  }
  return { ...input, expectedAgentId: input.expectedAgentId };
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new InvalidRequestError(`${key} must be a string`);
  return value;
}

function requireOperation(operationId: string | undefined): string {
  if (operationId === undefined)
    throw new InvalidRequestError("Mutation requires operation identity");
  return operationId;
}

function requirePiIdentity(identity: PiRuntimeIdentity | undefined): PiRuntimeIdentity {
  if (identity === undefined)
    throw new InvalidRequestError("Mutation requires Pi runtime identity");
  return identity;
}

async function writeStreamError(
  socket: Socket,
  requestId: string,
  error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  },
  timeoutMs: number,
): Promise<void> {
  if (socket.destroyed) return;
  await writeFrame(socket, { v: PROTOCOL_VERSION, requestId, stream: "error", error }, timeoutMs);
  socket.end();
}

async function writeFrame(
  socket: Socket,
  value: unknown,
  timeoutMs: number,
  maxBytes?: number,
): Promise<void> {
  if (socket.destroyed) throw new Error("Control socket is closed");
  if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(value)) + 1 > maxBytes) {
    throw new Error("Control protocol frame exceeds the configured limit");
  }
  if (writeJsonLine(socket, value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Control socket closed during write"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Control socket write timed out"));
    }, timeoutMs);
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function writeConnectionError(socket: Socket, value: unknown, error: unknown): void {
  if (socket.destroyed) return;
  const invalid = error instanceof InvalidRequestError;
  writeJsonLine(socket, {
    v: PROTOCOL_VERSION,
    requestId: requestIdFrom(value),
    ok: false,
    error: invalid
      ? { code: "invalid_request", message: error.message }
      : { code: "internal_error", message: "pi-fleet encountered an internal error." },
  });
  socket.end();
}

class InvalidRequestError extends Error {
  override readonly name = "InvalidRequestError";
}

function requestIdFrom(value: unknown): string {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return "unknown";
  return typeof value.requestId === "string" ? value.requestId : "unknown";
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const ownership = await inspectControlSocketOwnership(socketPath);
  if (ownership === "absent") return;
  if (ownership !== "stale") {
    throw new RuntimeOwnershipBlockedError(
      ownership === "responsive"
        ? `A responsive pi-fleet runtime already owns ${socketPath}`
        : `pi-fleet control socket ownership is uncertain for ${socketPath}`,
    );
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}
