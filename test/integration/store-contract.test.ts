import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLaunchProfile, observeSession } from "../../src/pi/launch-profile.js";
import type { FleetStore, StoredAgent } from "../../src/store/fleet-store.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { SqliteFleetStore } from "../../src/store/sqlite-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agent(): StoredAgent {
  const launch = observeSession(
    createLaunchProfile({ cwd: "/workspace", piArgv: [], piArtifactId: "pi@0.80.10" }),
    { path: "/home/user/.pi/agent/sessions/session.jsonl", id: "session-1" },
  );
  return {
    summary: {
      id: "agent-1",
      name: "reviewer",
      state: "idle",
      process: { state: "resident" },
      session: {
        path: launch.observedSession?.path ?? null,
        id: launch.observedSession?.id ?? null,
      },
    },
    launch,
    latestAssistantText: "latest",
    responseObservedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function exerciseStore(store: FleetStore): Promise<void> {
  expect(await store.createAgent(agent())).toBe(true);
  expect(await store.createAgent(agent())).toBe(false);
  expect(await store.getAgent("reviewer")).toEqual(agent());

  await store.putOperation({
    operationId: "operation-1",
    method: "send",
    fingerprint: "fingerprint",
    state: "completed",
    result: { ok: true },
  });
  expect(await store.getOperation("operation-1")).toMatchObject({ state: "completed" });

  await store.putSend({
    sendId: "send-1",
    agentName: "reviewer",
    message: "message",
    state: "dispatching",
    acceptedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(await store.listNonterminalSends()).toHaveLength(1);

  await store.putIncarnation({
    incarnationId: "incarnation-1",
    agentName: "reviewer",
    pid: 123,
    state: "live",
  });
  expect(await store.listActiveIncarnations()).toEqual([
    { incarnationId: "incarnation-1", agentName: "reviewer", pid: 123, state: "live" },
  ]);
}

describe("FleetStore contract", () => {
  it("is shared by memory and SQLite implementations", async () => {
    const memory = new MemoryFleetStore();
    await exerciseStore(memory);
    await memory.close();

    const root = await mkdtemp(join(tmpdir(), "pifleet-store-"));
    roots.push(root);
    const sqlite = new SqliteFleetStore(join(root, "fleet.sqlite"));
    await exerciseStore(sqlite);
    await sqlite.close();
  });

  it("persists agents, operations, and send certainty across clean reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-store-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const first = new SqliteFleetStore(path);
    await exerciseStore(first);
    await first.close(true);

    const second = new SqliteFleetStore(path);
    expect(await second.getAgent("reviewer")).toMatchObject({
      summary: { id: "agent-1", name: "reviewer", state: "idle", process: { state: "absent" } },
      latestAssistantText: "latest",
      launch: { observedSession: { path: "/home/user/.pi/agent/sessions/session.jsonl" } },
    });
    expect(await second.getOperation("operation-1")).toMatchObject({ state: "completed" });
    expect(await second.getSend("send-1")).toMatchObject({ state: "dispatching" });
    await second.close();
  });

  it("replays a completed operation after the service is reconstructed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-store-"));
    roots.push(root);
    const store = new SqliteFleetStore(join(root, "fleet.sqlite"));
    const firstService = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    const first = await firstService.create(
      { name: "reviewer", cwd: "/workspace", piArgv: [] },
      "create-operation",
    );
    const secondService = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    expect(
      await secondService.create(
        { name: "reviewer", cwd: "/workspace", piArgv: [] },
        "create-operation",
      ),
    ).toEqual(first);
    await store.close();
  });

  it("reconciles proven-pending sends and never replays dispatching sends", async () => {
    const store = new MemoryFleetStore();
    const stored = agent();
    await store.createAgent({
      ...stored,
      summary: { ...stored.summary, process: { state: "absent" } },
    });
    for (const [sendId, state] of [
      ["pending-send", "pending"],
      ["dispatching-send", "dispatching"],
    ] as const) {
      const input = { name: "reviewer", message: sendId };
      await store.putOperation({
        operationId: sendId,
        method: "send",
        fingerprint: JSON.stringify(input),
        state: "pending",
        result: null,
      });
      await store.putSend({
        sendId,
        agentName: "reviewer",
        message: sendId,
        state,
        acceptedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    const service = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    await service.reconcile();
    expect(await store.getSend("pending-send")).toMatchObject({ state: "acknowledged" });
    expect(await store.getOperation("pending-send")).toMatchObject({ state: "completed" });
    expect(await store.getSend("dispatching-send")).toMatchObject({ state: "uncertain" });
    expect(await store.getOperation("dispatching-send")).toMatchObject({
      state: "completed",
      result: { ok: false, error: { code: "delivery_uncertain" } },
    });
  });

  it("rejects changed migration checksums and newer schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-store-"));
    roots.push(root);
    const checksumPath = join(root, "checksum.sqlite");
    const initial = new SqliteFleetStore(checksumPath);
    await initial.close();
    const checksumDatabase = new DatabaseSync(checksumPath);
    checksumDatabase
      .prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1")
      .run();
    checksumDatabase.close();
    expect(() => new SqliteFleetStore(checksumPath)).toThrow(/checksum mismatch/i);

    const newerPath = join(root, "newer.sqlite");
    const newerInitial = new SqliteFleetStore(newerPath);
    await newerInitial.close();
    const newerDatabase = new DatabaseSync(newerPath);
    newerDatabase
      .prepare(
        "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(2, 'future', ?)",
      )
      .run(new Date().toISOString());
    newerDatabase.close();
    expect(() => new SqliteFleetStore(newerPath)).toThrow(/newer than this runtime/i);

    const rollbackPath = join(root, "rollback.sqlite");
    const incompatible = new DatabaseSync(rollbackPath);
    incompatible.exec("CREATE TABLE runtime_metadata(unexpected TEXT)");
    incompatible.close();
    expect(() => new SqliteFleetStore(rollbackPath)).toThrow();
    const inspected = new DatabaseSync(rollbackPath, { readOnly: true });
    const agentsTable = inspected
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
      .get();
    inspected.close();
    expect(agentsTable).toBeUndefined();
  });

  it("resumes pending create and destroy operations after reconstruction", async () => {
    const store = new MemoryFleetStore();
    const createInput = { name: "created", cwd: "/workspace", piArgv: [] };
    await store.putOperation({
      operationId: "pending-create",
      method: "create",
      fingerprint: JSON.stringify(createInput),
      state: "pending",
      result: null,
    });
    const service = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    await service.reconcile();
    expect(await store.getAgent("created")).not.toBeNull();
    expect(await store.getOperation("pending-create")).toMatchObject({ state: "completed" });

    const destroyInput = { name: "created" };
    await store.putOperation({
      operationId: "pending-destroy",
      method: "destroy",
      fingerprint: JSON.stringify(destroyInput),
      state: "pending",
      result: null,
      targetAgent: { id: (await store.getAgent("created"))!.summary.id, name: "created" },
    });
    const reconstructed = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    await reconstructed.reconcile();
    expect(await store.getAgent("created")).toBeNull();
    expect(await store.getOperation("pending-destroy")).toMatchObject({ state: "completed" });
  });

  it("replays pending operations at the post-mutation crash boundaries", async () => {
    const store = new MemoryFleetStore();
    const existing = agent();
    await store.createAgent(existing);
    const createInput = { name: "reviewer", cwd: "/workspace", piArgv: [] };
    await store.putOperation({
      operationId: "create-after-agent",
      method: "create",
      fingerprint: JSON.stringify(createInput),
      state: "pending",
      result: null,
      targetAgent: { id: existing.summary.id, name: existing.summary.name },
    });
    const service = new FleetService(store, () => "2026-01-01T00:00:00.000Z");
    expect(await service.create(createInput, "create-after-agent")).toMatchObject({
      ok: true,
      value: { agent: { id: "agent-1", name: "reviewer" } },
    });

    await store.deleteAgent("reviewer");
    const destroyInput = { name: "reviewer" };
    await store.putOperation({
      operationId: "destroy-after-delete",
      method: "destroy",
      fingerprint: JSON.stringify(destroyInput),
      state: "pending",
      result: null,
      targetAgent: { id: "agent-1", name: "reviewer" },
    });
    expect(await service.destroy(destroyInput, "destroy-after-delete")).toMatchObject({
      ok: true,
      value: { agent: { id: "agent-1", name: "reviewer" } },
    });
  });

  it("marks a possibly resident process cleanup-uncertain after unclean shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-store-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const first = new SqliteFleetStore(path);
    await first.createAgent(agent());
    await first.putIncarnation({
      incarnationId: "incarnation-1",
      agentName: "reviewer",
      pid: 123,
      state: "live",
    });
    await first.close(false);

    const second = new SqliteFleetStore(path);
    expect(await second.getAgent("reviewer")).toMatchObject({
      summary: { state: "failed", process: { state: "cleanup_uncertain" } },
    });
    expect(await second.listActiveIncarnations()).toEqual([
      {
        incarnationId: "incarnation-1",
        agentName: "reviewer",
        pid: 123,
        state: "cleanup_uncertain",
      },
    ]);
    await second.close();
  });
});
