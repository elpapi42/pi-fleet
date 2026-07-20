import { once } from "node:events";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type {
  CreateInput,
  DestroyInput,
  FleetClientError,
  ReceiveInput,
  SendInput,
  StatusInput,
} from "../client/fleet-client.js";
import { parseProtocolRequest } from "../protocol/validation.js";
import { readJsonLines, writeJsonLine } from "../protocol/jsonl.js";
import { MAX_PROTOCOL_FRAME_BYTES, PROTOCOL_VERSION } from "../protocol/version.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../shared/runtime-limits.js";
import { err, type Result } from "../shared/result.js";
import type { FleetService } from "./fleet-service.js";

export interface ControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function startControlServer(options: {
  readonly socketPath: string;
  readonly service: FleetService | Promise<FleetService>;
  readonly limits?: Pick<RuntimeLimits, "maxProtocolFrameBytes">;
}): Promise<ControlServer> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await prepareSocketPath(options.socketPath);

  const service = Promise.resolve(options.service);
  const maxFrameBytes =
    options.limits?.maxProtocolFrameBytes ?? DEFAULT_RUNTIME_LIMITS.maxProtocolFrameBytes;
  const server = createServer((socket) => handleConnection(socket, service, maxFrameBytes));
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
  maxFrameBytes: number,
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
        .then((readyService) => dispatch(value, readyService, socket, abort.signal, maxFrameBytes))
        .catch((error: unknown) => {
          if (socket.destroyed) return;
          const invalidRequest = error instanceof InvalidRequestError;
          writeJsonLine(socket, {
            v: PROTOCOL_VERSION,
            requestId: requestIdFrom(value),
            ok: false,
            error: invalidRequest
              ? { code: "invalid_request", message: error.message }
              : { code: "internal_error", message: "pi-fleet encountered an internal error." },
          });
          socket.end();
        });
    },
    (error) => {
      writeJsonLine(socket, {
        v: PROTOCOL_VERSION,
        requestId: "unknown",
        ok: false,
        error: { code: "invalid_request", message: error.message },
      });
      socket.end();
    },
    maxFrameBytes,
  );
}

async function dispatch(
  value: unknown,
  service: FleetService,
  socket: Socket,
  connectionSignal: AbortSignal,
  maxFrameBytes: number,
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
      result = await service.create(asCreateInput(request.params), requireOperation(operationId));
      break;
    case "agent.send":
      result = await service.send(asSendInput(request.params), requireOperation(operationId));
      break;
    case "agent.receive":
      result = await receiveWithTimeout(
        service,
        asNamedInput(request.params),
        numberParam(request.params, "timeoutMs"),
        connectionSignal,
      );
      break;
    case "agent.status":
      result = await service.status(asNamedInput(request.params));
      break;
    case "agent.list":
      result = await service.list();
      break;
    case "agent.watch": {
      const watch = await service.openWatch(asNamedInput(request.params), connectionSignal);
      if (!watch.ok) {
        writeJsonLine(socket, {
          v: PROTOCOL_VERSION,
          requestId: request.requestId,
          stream: "error",
          error: watch.error,
        });
        socket.end();
        return;
      }
      writeJsonLine(socket, { v: PROTOCOL_VERSION, requestId: request.requestId, stream: "ready" });
      try {
        const outgoingFrameLimit = Math.min(maxFrameBytes, MAX_PROTOCOL_FRAME_BYTES);
        const maxRawChunkBytes = Math.max(1, Math.floor((outgoingFrameLimit - 1024) * 0.75));
        for await (const chunk of watch.value) {
          for (let offset = 0; offset < chunk.length; offset += maxRawChunkBytes) {
            const part = chunk.subarray(offset, offset + maxRawChunkBytes);
            const writable = writeJsonLine(socket, {
              v: PROTOCOL_VERSION,
              requestId: request.requestId,
              stream: "chunk",
              data: part.toString("base64"),
            });
            if (!writable) await once(socket, "drain");
          }
        }
        if (!socket.destroyed) {
          writeJsonLine(socket, {
            v: PROTOCOL_VERSION,
            requestId: request.requestId,
            stream: "end",
          });
          socket.end();
        }
      } catch {
        if (!socket.destroyed) {
          writeJsonLine(socket, {
            v: PROTOCOL_VERSION,
            requestId: request.requestId,
            stream: "error",
            error: {
              code: "session_changed",
              message: "Pi session changed while watching.",
            },
          });
          socket.end();
        }
      }
      return;
    }
    case "agent.destroy":
      result = await service.destroy(asNamedInput(request.params), requireOperation(operationId));
      break;
  }

  writeJsonLine(
    socket,
    result.ok
      ? { v: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: result.value }
      : { v: PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: result.error },
  );
  socket.end();
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
  return { name: stringParam(params, "name"), message: stringParam(params, "message") };
}

function asNamedInput(params: Record<string, unknown>): ReceiveInput & StatusInput & DestroyInput {
  return { name: stringParam(params, "name") };
}

async function receiveWithTimeout(
  service: FleetService,
  input: ReceiveInput,
  timeoutMs: number | undefined,
  connectionSignal: AbortSignal,
): Promise<Result<unknown, FleetClientError>> {
  const abort = new AbortController();
  let timedOut = false;
  const onConnectionAbort = () => abort.abort();
  connectionSignal.addEventListener("abort", onConnectionAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, timeoutMs);
  try {
    return await service.receive(input, abort.signal);
  } catch (error: unknown) {
    if (timedOut) {
      return err({ code: "timeout", message: "Agent did not become idle before timeout." });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    connectionSignal.removeEventListener("abort", onConnectionAbort);
  }
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidRequestError(`${key} must be a non-negative number`);
  }
  return value;
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

class InvalidRequestError extends Error {
  override readonly name = "InvalidRequestError";
}

function requestIdFrom(value: unknown): string {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return "unknown";
  return typeof value.requestId === "string" ? value.requestId : "unknown";
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const stats = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return;
  if (!stats.isSocket()) throw new Error(`Refusing to replace non-socket path ${socketPath}`);
  if (await canConnect(socketPath))
    throw new Error(`A pi-fleet runtime already owns ${socketPath}`);
  await unlink(socketPath);
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveConnect(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveConnect(false);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}
