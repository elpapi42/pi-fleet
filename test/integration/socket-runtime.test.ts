import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "pifleet-socket-test-"));
  const socketPath = join(root, "control.sock");
  const store = new MemoryFleetStore();
  const service = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
  const server: ControlServer = await startControlServer({ socketPath, service });
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

  it("returns typed errors instead of leaking private protocol frames", async () => {
    const { client } = await harness();

    expect(await client.status({ name: "missing" }, { signal })).toEqual({
      ok: false,
      error: { code: "agent_not_found", message: "Agent missing was not found." },
    });
  });
});
