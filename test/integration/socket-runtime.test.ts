import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { frameIterator, SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import type { PiRuntimeIdentity } from "../../src/protocol/pi-identity.js";
import { PROTOCOL_VERSION } from "../../src/protocol/version.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import type { RuntimeLimits } from "../../src/shared/runtime-limits.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(limits?: Partial<RuntimeLimits>, launcher?: PiLauncher) {
  const root = await mkdtemp(join(tmpdir(), "pifleet-socket-test-"));
  const socketPath = join(root, "control.sock");
  const store = new MemoryFleetStore();
  const service = new FleetService(store, {
    now: () => "2026-01-01T00:00:00.000Z",
    ...(limits === undefined ? {} : { limits }),
    ...(launcher === undefined ? {} : { launcher }),
  });
  const server: ControlServer = await startControlServer({
    socketPath,
    service,
    ...(limits?.maxProtocolFrameBytes === undefined
      ? {}
      : { limits: { maxProtocolFrameBytes: limits.maxProtocolFrameBytes } }),
  });
  cleanups.push(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client: new SocketFleetClient({ socketPath }), socketPath, service, store, root };
}

async function protocolFixture(
  respond: (requestId: string) => Record<string, unknown>,
): Promise<{ client: SocketFleetClient; closed: Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-protocol-version-"));
  const socketPath = join(root, "control.sock");
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as { requestId: string };
      socket.write(`${JSON.stringify(respond(request.requestId))}\n`);
    });
    socket.once("close", () => resolveClosed());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    ).finally(() => rm(root, { recursive: true, force: true })),
  );
  return { client: new SocketFleetClient({ socketPath }), closed };
}

function streamingLauncher(): {
  readonly launcher: PiLauncher;
  emit(bytes: Buffer): void;
} {
  let sink: ((bytes: Buffer) => void) | undefined;
  let exitListener: ((error: Error | null) => void) | undefined;
  const process = {
    pid: 51_000,
    async getState() {
      return {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: "/tmp/rpc-session.jsonl",
        sessionId: "rpc-session",
      };
    },
    async prompt() {},
    async getLastAssistantText() {
      return null;
    },
    onFrame() {
      return () => undefined;
    },
    onExit(listener: (error: Error | null) => void) {
      exitListener = listener;
      return () => undefined;
    },
    async stop() {
      exitListener?.(null);
    },
  } as unknown as PiProcess;
  return {
    launcher: {
      artifactId: "streaming-pi",
      async start(_profile, _restore, _onSpawn, onStdoutBytes) {
        sink = onStdoutBytes;
        return process;
      },
    },
    emit(bytes) {
      if (sink === undefined) throw new Error("Pi stdout sink is not installed");
      sink(bytes);
    },
  };
}

const signal = new AbortController().signal;
const operation = { operationId: "operation-1", createdAt: "2026-01-01T00:00:00.000Z" };

describe("private socket runtime", () => {
  it("creates, lists, and destroys one pi-fleet entry across the real protocol", async () => {
    const { client } = await harness();

    const created = await client.create(
      { name: "reviewer", cwd: "/workspace", piArgv: [] },
      { signal, operation },
    );
    expect(created).toMatchObject({ ok: true, value: { type: "agent.created" } });

    const listed = await client.list({ signal });
    expect(listed).toMatchObject({
      ok: true,
      value: { type: "agent.list", agents: [{ name: "reviewer" }] },
    });

    const destroyed = await client.destroy(
      { name: "reviewer" },
      {
        signal,
        operation: { operationId: "operation-2", createdAt: operation.createdAt },
      },
    );
    expect(destroyed).toMatchObject({ ok: true, value: { type: "agent.destroyed" } });
    expect(await client.list({ signal })).toMatchObject({
      ok: true,
      value: { agents: [] },
    });
  });

  it("maps an older runtime rejecting compact to protocol_incompatible", async () => {
    const fixture = await protocolFixture((requestId) => ({
      v: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code: "invalid_request", message: "Invalid protocol request: /method" },
    }));

    expect(
      await fixture.client.compact(
        { name: "reviewer" },
        {
          signal,
          operation: { operationId: "compact-old-runtime", createdAt: operation.createdAt },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "protocol_incompatible" } });
    await fixture.closed;
  });

  it("preserves current-runtime compact validation errors", async () => {
    const fixture = await protocolFixture((requestId) => ({
      v: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code: "invalid_request", message: "Invalid protocol request: /operation" },
    }));

    expect(
      await fixture.client.compact(
        { name: "reviewer" },
        { signal, operation: { operationId: "compact-invalid", createdAt: operation.createdAt } },
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await fixture.closed;
  });

  it("compacts an idle agent through the real protocol and replays the operation", async () => {
    const { client } = await harness();
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });
    const compactOperation = { operationId: "compact-1", createdAt: operation.createdAt };
    const first = await client.compact(
      { name: "reviewer" },
      { signal, operation: compactOperation },
    );
    const retry = await client.compact(
      { name: "reviewer" },
      { signal, operation: compactOperation },
    );
    expect(first).toMatchObject({
      ok: true,
      value: { type: "agent.compacted", agent: { name: "reviewer" } },
    });
    expect(retry).toEqual(first);
  });

  it("rejects compact when the agent is not idle", async () => {
    const { client, store } = await harness();
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });
    const stored = await store.getAgent("reviewer");
    if (stored === null) throw new Error("missing stored agent");
    await store.putAgent({
      ...stored,
      summary: { ...stored.summary, state: "working", process: { state: "resident" } },
    });
    expect(
      await client.compact(
        { name: "reviewer" },
        { signal, operation: { operationId: "compact-busy", createdAt: operation.createdAt } },
      ),
    ).toMatchObject({ ok: false, error: { code: "agent_busy" } });
  });

  it("replays one operation result and rejects reuse with another payload", async () => {
    const { client } = await harness();
    const first = await client.create(
      { name: "reviewer", cwd: "/workspace", piArgv: [] },
      { signal, operation },
    );
    const retry = await client.create(
      { name: "reviewer", cwd: "/workspace", piArgv: [] },
      { signal, operation },
    );
    expect(retry).toEqual(first);

    expect(
      await client.create(
        { name: "different", cwd: "/workspace", piArgv: [] },
        { signal, operation },
      ),
    ).toMatchObject({ ok: false, error: { code: "operation_conflict" } });
  });

  it("exposes readiness separately and streams exact raw Pi RPC bytes", async () => {
    const streaming = streamingLauncher();
    const { client } = await harness(undefined, streaming.launcher);
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });

    const abort = new AbortController();
    const stream = client.watch({ name: "reviewer" }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const ready = await iterator.next();
    expect(ready).toMatchObject({
      value: { ok: true, value: { type: "ready" } },
    });
    const next = iterator.next();
    const raw = Buffer.from([
      ...Buffer.from(
        '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\\"path\\":"}}\r\n',
      ),
      0xff,
      0x00,
    ]);

    streaming.emit(raw);

    const frame = await next;
    if (frame.value?.ok !== true || frame.value.value.type !== "chunk") {
      throw new Error("watch failed");
    }
    expect(Buffer.from(frame.value.value.bytes)).toEqual(raw);
    abort.abort();
    await iterator.return?.();
  });

  it("chunks oversized raw RPC writes through private frames without changing bytes", async () => {
    const streaming = streamingLauncher();
    const { client } = await harness({ maxProtocolFrameBytes: 1_200 }, streaming.launcher);
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });

    const abort = new AbortController();
    const stream = client.watch({ name: "reviewer" }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const raw = Buffer.from(
      `${JSON.stringify({ type: "message_update", opaque: "x".repeat(1_500) })}\npartial`,
    );
    let received = Buffer.alloc(0);
    let nextFrame = iterator.next();

    streaming.emit(raw);

    while (received.length < raw.length) {
      const frame = await nextFrame;
      if (frame.value?.ok !== true || frame.value.value.type !== "chunk") {
        throw new Error("watch failed");
      }
      received = Buffer.concat([received, Buffer.from(frame.value.value.bytes)]);
      if (received.length < raw.length) nextFrame = iterator.next();
    }
    expect(received).toEqual(raw);
    abort.abort();
    await iterator.return?.();
  });

  it("reports a lagging raw RPC watcher without filtering or blocking Pi", async () => {
    const streaming = streamingLauncher();
    const { client } = await harness({ maxWatchQueuedBytes: 4 }, streaming.launcher);
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });
    const iterator = client.watch({ name: "reviewer" }, { signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: true, value: { type: "ready" } },
    });

    streaming.emit(Buffer.from("12345"));

    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: false, error: { code: "watcher_lagged" } },
    });
  });

  it("pauses and resumes watch input when the client frame queue reaches its byte bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-socket-pressure-"));
    const socketPath = join(root, "control.sock");
    let serverSocket!: Socket;
    const server = createServer((socket) => {
      serverSocket = socket;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const clientSocket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      clientSocket.once("connect", resolve);
      clientSocket.once("error", reject);
    });
    const abort = new AbortController();
    const iterator = frameIterator(clientSocket, abort.signal, 128)[Symbol.asyncIterator]();
    const first = iterator.next();
    const frame = `${JSON.stringify({ payload: "x".repeat(100) })}\n`;
    serverSocket.write(frame);
    serverSocket.write(frame);

    await first;
    expect(clientSocket.isPaused()).toBe(true);
    await iterator.next();
    expect(clientSocket.isPaused()).toBe(false);

    abort.abort();
    await iterator.return?.();
    clientSocket.destroy();
    serverSocket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("reports unexpected watch socket EOF as runtime unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-socket-eof-"));
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString().trim()) as { requestId: string };
        socket.end(
          `${JSON.stringify({ v: PROTOCOL_VERSION, requestId: request.requestId, stream: "ready" })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(() =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ).finally(() => rm(root, { recursive: true, force: true })),
    );

    const client = new SocketFleetClient({ socketPath });
    const iterator = client.watch({ name: "reviewer" }, { signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: true, value: { type: "ready" } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: false, error: { code: "runtime_unavailable" } },
    });
  });

  it("persists a new Pi identity mismatch but replays an earlier completed operation", async () => {
    const { client, socketPath, store } = await harness();
    const input = { name: "reviewer", cwd: "/workspace", piArgv: [] } as const;
    const stableOperation = {
      operationId: "identity-stable",
      createdAt: operation.createdAt,
    };
    const first = await client.create(input, { signal, operation: stableOperation });
    expect(first).toMatchObject({ ok: true });

    const externalIdentity: PiRuntimeIdentity = {
      mode: "external",
      selectedPath: "/tmp/pi",
      realPath: "/tmp/pi-target",
      version: "0.82.1",
      fingerprint: "different",
    };
    const mismatched = new SocketFleetClient({ socketPath, piIdentity: externalIdentity });

    expect(await mismatched.create(input, { signal, operation: stableOperation })).toEqual(first);
    const rejected = await mismatched.create(
      { name: "other", cwd: "/workspace", piArgv: [] },
      {
        signal,
        operation: { operationId: "identity-mismatch", createdAt: operation.createdAt },
      },
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: "pi_runtime_mismatch" } });
    expect(await store.getAgent("other")).toBeNull();
    expect(await store.getOperation("identity-mismatch")).toMatchObject({
      state: "completed",
      result: rejected,
    });
  });

  it("accepts a matching protocol-major response and closes the connection", async () => {
    const { client, closed } = await protocolFixture((requestId) => ({
      v: PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: { type: "agent.list", agents: [] },
    }));

    await expect(client.list({ signal })).resolves.toEqual({
      ok: true,
      value: { type: "agent.list", agents: [] },
    });
    await expect(closed).resolves.toBeUndefined();
  });

  it("rejects an incompatible protocol-major response and closes the connection", async () => {
    const { client, closed } = await protocolFixture((requestId) => ({
      v: PROTOCOL_VERSION + 1,
      requestId,
      ok: true,
      result: { type: "agent.list", agents: [] },
    }));

    await expect(client.list({ signal })).resolves.toEqual({
      ok: false,
      error: {
        code: "protocol_incompatible",
        message:
          "The running pi-fleet runtime is incompatible with this client; repair or restart it.",
      },
    });
    await expect(closed).resolves.toBeUndefined();
  });

  it("rejects an incompatible watch stream protocol-major and closes the connection", async () => {
    const { client, closed } = await protocolFixture((requestId) => ({
      v: PROTOCOL_VERSION + 1,
      requestId,
      stream: "ready",
    }));

    const iterator = client.watch({ name: "reviewer" }, { signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        ok: false,
        error: {
          code: "protocol_incompatible",
          message:
            "The running pi-fleet runtime is incompatible with this client; repair or restart it.",
        },
      },
    });
    await iterator.return?.();
    await expect(closed).resolves.toBeUndefined();
  });

  it("returns typed errors instead of leaking private protocol frames", async () => {
    const { client } = await harness();

    expect(await client.status({ name: "missing" }, { signal })).toEqual({
      ok: false,
      error: { code: "agent_not_found", message: "Agent missing was not found." },
    });
  });
});
