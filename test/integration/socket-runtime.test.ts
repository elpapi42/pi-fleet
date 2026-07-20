import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { frameIterator, SocketFleetClient } from "../../src/client/socket-fleet-client.js";
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

const signal = new AbortController().signal;
const operation = { operationId: "operation-1", createdAt: "2026-01-01T00:00:00.000Z" };

describe("private socket runtime", () => {
  it("creates, lists, and destroys one named agent across the real protocol", async () => {
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

  it("streams only decoded session bytes after the private ready frame", async () => {
    const { client, store, root } = await harness();
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });
    const stored = await store.getAgent("reviewer");
    if (stored === null) throw new Error("missing stored agent");
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, '{"type":"session"}\n');
    await store.putAgent({
      ...stored,
      summary: { ...stored.summary, session: { path: sessionPath, id: "session-1" } },
    });

    const abort = new AbortController();
    const stream = client.watchSession({ name: "reviewer" }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    await appendFile(sessionPath, '{"type":"message"}\n');

    const frame = await next;
    expect(frame.value).toMatchObject({ ok: true });
    if (frame.value?.ok !== true) throw new Error("watch failed");
    expect(Buffer.from(frame.value.value.bytes).toString()).toBe('{"type":"message"}\n');
    abort.abort();
    await iterator.return?.();
  });

  it("chunks a complete session record through bounded private frames without changing bytes", async () => {
    const { client, store, root } = await harness({
      maxProtocolFrameBytes: 1_200,
      maxSessionRecordBytes: 4_096,
    });
    await client.create({ name: "reviewer", cwd: "/workspace", piArgv: [] }, { signal, operation });
    const stored = await store.getAgent("reviewer");
    if (stored === null) throw new Error("missing stored agent");
    const sessionPath = join(root, "large-session.jsonl");
    await writeFile(sessionPath, '{"type":"session"}\n');
    await store.putAgent({
      ...stored,
      summary: { ...stored.summary, session: { path: sessionPath, id: "session-1" } },
    });

    const abort = new AbortController();
    const stream = client.watchSession({ name: "reviewer" }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    let nextFrame = iterator.next();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    const record = `${JSON.stringify({ type: "message", text: "x".repeat(1_500) })}\n`;
    await appendFile(sessionPath, record);

    let received = "";
    while (!received.endsWith("\n")) {
      const frame = await nextFrame;
      if (frame.value?.ok !== true) throw new Error("watch failed");
      received += Buffer.from(frame.value.value.bytes).toString();
      if (!received.endsWith("\n")) nextFrame = iterator.next();
    }
    expect(received).toBe(record);
    abort.abort();
    await iterator.return?.();
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
        socket.end(`${JSON.stringify({ v: 1, requestId: request.requestId, stream: "ready" })}\n`);
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
    const stream = client.watchSession({ name: "reviewer" }, { signal });
    const result = await stream[Symbol.asyncIterator]().next();
    expect(result.value).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
  });

  it("returns typed errors instead of leaking private protocol frames", async () => {
    const { client } = await harness();

    expect(await client.status({ name: "missing" }, { signal })).toEqual({
      ok: false,
      error: { code: "agent_not_found", message: "Agent missing was not found." },
    });
  });
});
