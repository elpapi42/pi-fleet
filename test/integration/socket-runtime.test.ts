import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { frameIterator, SocketFleetClient } from "../../src/client/socket-fleet-client.js";
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

async function harness(limits?: Partial<RuntimeLimits>) {
  const root = await mkdtemp(join(tmpdir(), "pifleet-socket-test-"));
  const socketPath = join(root, "control.sock");
  const store = new MemoryFleetStore();
  const service = new FleetService(store, {
    now: () => "2026-01-01T00:00:00.000Z",
    ...(limits === undefined ? {} : { limits }),
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

  it("pauses and resumes receive input when the client frame queue reaches its byte bound", async () => {
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
      nodePath: "/tmp/node",
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

  it.each([
    {
      label: "accepts a last safe cursor on an ordinary terminal stream failure",
      error: {
        code: "runtime_unavailable",
        message: "Receive stream failed.",
        details: { lastSafeCursor: "cursor-1" },
      },
      expected: { code: "runtime_unavailable", details: { lastSafeCursor: "cursor-1" } },
    },
    {
      label: "accepts continuation cursors only for observation uncertainty",
      error: {
        code: "observation_uncertain",
        message: "Receive stream failed.",
        details: { lastSafeCursor: "cursor-1", continuationCursor: "cursor-2" },
      },
      expected: {
        code: "observation_uncertain",
        details: { lastSafeCursor: "cursor-1", continuationCursor: "cursor-2" },
      },
    },
    {
      label: "rejects a continuation cursor on an ordinary terminal stream failure",
      error: {
        code: "runtime_unavailable",
        message: "Receive stream failed.",
        details: { lastSafeCursor: "cursor-1", continuationCursor: "cursor-2" },
      },
      expected: { code: "protocol_error" },
    },
    {
      label: "rejects unrecognized error detail payloads",
      error: {
        code: "storage_unavailable",
        message: "Receive stream failed.",
        details: { lastSafeCursor: "cursor-1", prompt: "raw retained content" },
      },
      expected: { code: "protocol_error" },
    },
  ])("$label", async ({ error, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-stream-error-"));
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as {
          requestId: string;
        };
        socket.write(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            requestId: request.requestId,
            stream: "ready",
            cursor: "cursor-0",
            limits: { maxEventBytes: 1024, maxSegments: 4 },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            requestId: request.requestId,
            stream: "error",
            error,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((closeError) => (closeError === undefined ? resolve() : reject(closeError))),
      );
      await rm(root, { recursive: true, force: true });
    });

    const client = new SocketFleetClient({ socketPath });
    const items: unknown[] = [];
    for await (const item of client.receive(
      { name: "reviewer", expectedAgentId: "11111111-1111-4111-8111-111111111111" },
      { signal },
    )) {
      items.push(item);
    }

    expect(items[0]).toMatchObject({ ok: true, value: { type: "ready" } });
    expect(items[1]).toMatchObject({ ok: false, error: expected });
  });

  it("returns typed errors instead of leaking private protocol frames", async () => {
    const { client } = await harness();

    expect(await client.status({ name: "missing" }, { signal })).toEqual({
      ok: false,
      error: { code: "agent_not_found", message: "Agent missing was not found." },
    });
  });
});
