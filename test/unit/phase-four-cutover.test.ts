import { chmod, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import {
  assertNoOtherProcessHasDatabaseOpen,
  inspectJournalSchema,
  reconcileObservationContinuity,
} from "../../src/entry/runtime.js";
import { RealPiLauncher } from "../../src/pi/adapter.js";
import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { PiProcess, PiResponseCommitDelayError } from "../../src/pi/process.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { JournalRuntimeComposition } from "../../src/runtime/journal-runtime.js";
import { JournalWakeup } from "../../src/runtime/journal-wakeup.js";
import { OpaqueReceiveCursorCodec } from "../../src/runtime/receive-pager.js";
import type { AgentId, ContinuityEpoch, IncarnationId } from "../../src/runtime/semantic-events.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/shared/runtime-limits.js";
import { JournalFleetStoreAdapter } from "../../src/store/journal-fleet-store-adapter.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";
import { SqliteJournalStore } from "../../src/store/sqlite-journal-store.js";

const processes: PiProcess[] = [];
const servers: ControlServer[] = [];
const services: FleetService[] = [];
const roots: string[] = [];
const signal = new AbortController().signal;
const scriptedPiPath = new URL("../fixtures/scripted-pi.mjs", import.meta.url).pathname;

class IdleFailJournalStore extends MemoryJournalStore {
  failIdle = false;

  override markIdle(agentId: AgentId, epoch: ContinuityEpoch): Promise<number> {
    if (this.failIdle) return Promise.reject(new Error("injected idle marker failure"));
    return super.markIdle(agentId, epoch);
  }
}

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.stop().catch(() => undefined)));
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protocol-v3 coordinated cutover", () => {
  it("does not publish a Pi response until its raw record commit completes", async () => {
    let release: (() => void) | undefined;
    let admitted: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let blockPrompt = false;
    const process = await PiProcess.start({
      executable: globalThis.process.execPath,
      argvPrefix: [scriptedPiPath],
      piArgv: [],
      cwd: "/tmp",
      onStdoutRecord: async (record) => {
        if (!blockPrompt || !record.includes(Buffer.from('"command":"prompt"'))) return;
        admitted?.();
        await blocked;
      },
    });
    processes.push(process);
    blockPrompt = true;
    let settled = false;
    const prompt = process.prompt("hello").then(() => {
      settled = true;
    });
    await observed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release?.();
    await prompt;
    expect(settled).toBe(true);
  });

  it("classifies a matching response blocked on durability as storage failure", async () => {
    let blockPrompt = false;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = await PiProcess.start({
      executable: globalThis.process.execPath,
      argvPrefix: [scriptedPiPath],
      piArgv: [],
      cwd: "/tmp",
      onStdoutRecord: async (record) => {
        if (blockPrompt && record.includes(Buffer.from('"command":"prompt"'))) await blocked;
      },
    });
    processes.push(process);
    blockPrompt = true;
    await expect(process.request({ type: "prompt", message: "hello" }, 20)).rejects.toBeInstanceOf(
      PiResponseCommitDelayError,
    );
    release?.();
  });

  it("isolates same-name generations and streams an atomic live cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase4-"));
    roots.push(root);
    const journalStore = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(journalStore);
    const wakeup = new JournalWakeup();
    const journal = new JournalRuntimeComposition({
      store: journalStore,
      limits: DEFAULT_RUNTIME_LIMITS,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup,
      notifyEvents: (agentId, position) => wakeup.notify(agentId, position),
    });
    const service = new FleetService(adapter, {
      limits: DEFAULT_RUNTIME_LIMITS,
      journal,
      journalStore,
    });
    services.push(service);
    const socketPath = join(root, "control.sock");
    const server = await startControlServer({
      socketPath,
      service,
      journal: async () => journal,
      limits: DEFAULT_RUNTIME_LIMITS,
    });
    servers.push(server);
    const client = new SocketFleetClient({ socketPath });
    const operation = (id: string) => ({ operationId: id, createdAt: "2026-01-01T00:00:00Z" });
    const first = await client.create(
      { name: "reviewer", cwd: "/tmp", piArgv: [] },
      { signal, operation: operation("create-1") },
    );
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.value.agent.id : "";
    const stream = client.receive({ name: "reviewer", untilIdle: true }, { signal });
    const received = [];
    for await (const item of stream) received.push(item);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ ok: true, value: { type: "ready" } });

    const destroyed = await client.destroy(
      { name: "reviewer", expectedAgentId: firstId },
      { signal, operation: operation("destroy-1") },
    );
    expect(destroyed.ok).toBe(true);
    expect(await journalStore.getDestroyReceipt("destroy-1")).toMatchObject({ agentId: firstId });
    const second = await client.create(
      { name: "reviewer", cwd: "/tmp", piArgv: [] },
      { signal, operation: operation("create-2") },
    );
    expect(second.ok).toBe(true);
    const stale = await client.send(
      { name: "reviewer", expectedAgentId: firstId, message: "stale" },
      { signal, operation: operation("send-stale") },
    );
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_agent" } });
    const retained = await journalStore.getAgentById(firstId as AgentId);
    expect(retained).toBeNull();
  });

  it("reconciles a crash after atomic provisional creation without stranding restoring", async () => {
    const journalStore = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(journalStore);
    const id = "provisional-agent" as AgentId;
    const input = { name: "reviewer", cwd: "/tmp", piArgv: [] };
    const operation = {
      operationId: "provisional-create",
      method: "create" as const,
      fingerprint: JSON.stringify(input),
      targetName: "reviewer",
      state: "pending" as const,
      result: null,
      targetAgent: { id, name: "reviewer" },
    };
    expect(
      await adapter.createAgent(
        {
          summary: {
            id,
            name: "reviewer",
            state: "restoring",
            process: { state: "starting" },
            session: { id: null, path: null },
          },
          launch: createLaunchProfile({ cwd: "/tmp", piArgv: [] }),
        },
        operation,
      ),
    ).toBe(true);

    const restarted = new FleetService(adapter);
    await restarted.reconcile();
    expect(await adapter.getAgent("reviewer")).toBeNull();
    expect(await adapter.getOperation("provisional-create")).toMatchObject({
      state: "completed",
      result: { ok: false, error: { code: "pi_start_failed" } },
    });
  });

  it("reconciles an idle provisional agent as a completed successful create", async () => {
    const journalStore = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(journalStore);
    const id = "settled-provisional-agent" as AgentId;
    const operation = {
      operationId: "settled-provisional-create",
      method: "create" as const,
      fingerprint: "sha256:settled",
      targetName: "reviewer",
      state: "pending" as const,
      result: null,
      targetAgent: { id, name: "reviewer" },
    };
    expect(
      await adapter.createAgent(
        {
          summary: {
            id,
            name: "reviewer",
            state: "idle",
            process: { state: "absent" },
            session: { id: null, path: null },
          },
          launch: createLaunchProfile({ cwd: "/tmp", piArgv: [] }),
        },
        operation,
      ),
    ).toBe(true);

    await new FleetService(adapter).reconcile();
    expect(await adapter.getOperation(operation.operationId)).toMatchObject({
      state: "completed",
      result: { ok: true, value: { type: "agent.created", agent: { id } } },
    });
    expect(await adapter.getAgent("reviewer")).toMatchObject({ summary: { id, state: "idle" } });
  });

  it("replays pre-target failures and exact destroy results after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase4-operation-receipts-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");

    let journalStore = new SqliteJournalStore(path);
    let service = new FleetService(new JournalFleetStoreAdapter(journalStore));
    const missing = await service.send(
      { name: "reviewer", message: "must never dispatch" },
      "missing-send",
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "agent_not_found" } });
    const missingReceipt = await journalStore.getOperation("missing-send");
    expect(missingReceipt?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(missingReceipt)).not.toContain("must never dispatch");
    await journalStore.close();

    journalStore = new SqliteJournalStore(path);
    service = new FleetService(new JournalFleetStoreAdapter(journalStore));
    const created = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create");
    expect(created.ok).toBe(true);
    const retriedMissing = await service.send(
      { name: "reviewer", message: "must never dispatch" },
      "missing-send",
    );
    expect(retriedMissing).toEqual(missing);
    const agentId = created.ok ? created.value.agent.id : "";
    const destroyed = await service.destroy(
      { name: "reviewer", expectedAgentId: agentId },
      "destroy",
    );
    expect(destroyed.ok).toBe(true);
    const destroyReceipt = await journalStore.getDestroyReceipt("destroy");
    expect(destroyReceipt?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(destroyReceipt)).not.toContain("must never dispatch");
    await journalStore.close();

    journalStore = new SqliteJournalStore(path);
    service = new FleetService(new JournalFleetStoreAdapter(journalStore));
    await expect(
      service.destroy({ name: "reviewer", expectedAgentId: agentId }, "destroy"),
    ).resolves.toEqual(destroyed);
    await journalStore.close();
  });

  it("streams durable semantic activity through steering and follow-up delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase4-semantic-"));
    roots.push(root);
    const journalStore = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(journalStore);
    const wakeup = new JournalWakeup();
    const journal = new JournalRuntimeComposition({
      store: journalStore,
      limits: DEFAULT_RUNTIME_LIMITS,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup,
      notifyEvents: (agentId, position) => wakeup.notify(agentId, position),
    });
    const launcher = new RealPiLauncher({
      executable: globalThis.process.execPath,
      artifactId: "scripted-pi",
      argvPrefix: [scriptedPiPath],
      env: { PIFLEET_TEST_PI_MODE: "semantic" },
    });
    const service = new FleetService(adapter, {
      launcher,
      limits: DEFAULT_RUNTIME_LIMITS,
      journal,
      journalStore,
    });
    services.push(service);
    const socketPath = join(root, "control.sock");
    const server = await startControlServer({
      socketPath,
      service,
      journal: async () => journal,
      limits: DEFAULT_RUNTIME_LIMITS,
    });
    servers.push(server);
    const client = new SocketFleetClient({ socketPath });
    const operation = (operationId: string) => ({
      operationId,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const created = await client.create(
      { name: "worker", cwd: "/tmp", piArgv: [] },
      { signal, operation: operation("semantic-create") },
    );
    expect(created.ok).toBe(true);
    const agentId = created.ok ? created.value.agent.id : "";
    expect(await journalStore.getOperation("semantic-create")).toMatchObject({
      agentId,
      state: "completed",
    });
    const sent = await client.send(
      { name: "worker", expectedAgentId: agentId, message: "work", delivery: "steer" },
      { signal, operation: operation("semantic-send") },
    );
    expect(sent.ok).toBe(true);
    expect(await journalStore.getOperation("semantic-send")).toMatchObject({
      agentId,
      state: "completed",
    });
    const items = [];
    for await (const item of client.receive(
      { name: "worker", expectedAgentId: agentId, start: { kind: "start" } },
      { signal },
    )) {
      items.push(item);
      if (
        items.filter((candidate) => candidate.ok && candidate.value.type === "event").length === 4
      ) {
        break;
      }
    }
    expect(
      items.flatMap((item) =>
        item.ok && item.value.type === "event" ? [item.value.event.type] : [],
      ),
    ).toEqual([
      "assistant.thinking.started",
      "assistant.thinking.finished",
      "assistant.message.started",
      "assistant.message.finished",
    ]);
    const followed = await client.send(
      { name: "worker", expectedAgentId: agentId, message: "later", delivery: "followUp" },
      { signal, operation: operation("semantic-follow-up") },
    );
    expect(followed.ok).toBe(true);
  });

  it("fails the agent instead of publishing idle when the durable idle marker fails", async () => {
    const journalStore = new IdleFailJournalStore();
    const adapter = new JournalFleetStoreAdapter(journalStore);
    const wakeup = new JournalWakeup();
    const journal = new JournalRuntimeComposition({
      store: journalStore,
      limits: DEFAULT_RUNTIME_LIMITS,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup,
      notifyEvents: (agentId, position) => wakeup.notify(agentId, position),
    });
    const launcher = new RealPiLauncher({
      executable: globalThis.process.execPath,
      artifactId: "scripted-pi",
      argvPrefix: [scriptedPiPath],
      env: { PIFLEET_TEST_PI_MODE: "semantic" },
    });
    const service = new FleetService(adapter, {
      launcher,
      limits: DEFAULT_RUNTIME_LIMITS,
      journal,
      journalStore,
    });
    services.push(service);
    const created = await service.create(
      { name: "idle-failure", cwd: "/tmp", piArgv: [] },
      "idle-failure-create",
    );
    expect(created.ok).toBe(true);
    journalStore.failIdle = true;
    await expect(
      service.send(
        {
          name: "idle-failure",
          expectedAgentId: created.ok ? created.value.agent.id : "",
          message: "work",
        },
        "idle-failure-send",
      ),
    ).resolves.toMatchObject({ ok: true });

    let status = await service.status({ name: "idle-failure" });
    for (
      let attempt = 0;
      attempt < 50 && status.ok && status.value.agent.state !== "failed";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await service.status({ name: "idle-failure" });
    }
    expect(status).toMatchObject({
      ok: true,
      value: { agent: { state: "failed", error: { code: "storage_unavailable" } } },
    });
  });

  it("classifies destructive schemas fail-closed and detects a legacy database owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase4-schema-ownership-"));
    roots.push(root);
    const databasePath = join(root, "fleet.sqlite");
    expect(inspectJournalSchema(databasePath)).toBe("fresh");

    let database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(1, ?, '')")
      .run("001_initial_v1");
    database.close();
    expect(inspectJournalSchema(databasePath)).toBe("legacy");

    const procRoot = join(root, "proc");
    const fakePid = process.pid + 100_000;
    await mkdir(join(procRoot, String(fakePid), "fd"), { recursive: true });
    await link(databasePath, join(procRoot, String(fakePid), "fd", "1"));
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).toThrow(
      /still owns the pi-fleet database/i,
    );
    await rm(procRoot, { recursive: true, force: true });
    await mkdir(procRoot);
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).not.toThrow();

    // A same-user zombie exposes an unreadable fd directory but owns nothing.
    const zombiePid = process.pid + 200_000;
    await mkdir(join(procRoot, String(zombiePid), "fd"), { recursive: true });
    await writeFile(
      join(procRoot, String(zombiePid), "stat"),
      `${String(zombiePid)} (cosmic-term) Z 1 1 1 0 -1 0 0 0 0 0\n`,
    );
    await chmod(join(procRoot, String(zombiePid), "fd"), 0o000);
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).not.toThrow();

    // A live same-user process the kernel hides cannot be a pi-fleet runtime, so the
    // sweep skips it and SQLite locking remains the authoritative proof.
    await writeFile(
      join(procRoot, String(zombiePid), "stat"),
      `${String(zombiePid)} (systemd) S 1 1 1 0 -1 0 0 0 0 0\n`,
    );
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).not.toThrow();
    await chmod(join(procRoot, String(zombiePid), "fd"), 0o700);
    await rm(join(procRoot, String(zombiePid)), { recursive: true, force: true });

    // A live writer elsewhere on the host still fails closed through SQLite locking.
    const writer = new DatabaseSync(databasePath);
    writer.exec("BEGIN EXCLUSIVE");
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).toThrow(
      /Cannot prove another runtime released the pi-fleet database/i,
    );
    writer.exec("ROLLBACK");
    writer.close();
    expect(() => assertNoOtherProcessHasDatabaseOpen(databasePath, procRoot)).not.toThrow();

    database = new DatabaseSync(databasePath);
    database.prepare("UPDATE schema_migrations SET checksum = 'wrong'").run();
    database.close();
    expect(() => inspectJournalSchema(databasePath)).toThrow(/checksum mismatch/i);
  });

  it("rejects a version-2-only migration ledger before destructive reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase4-malformed-ledger-"));
    roots.push(root);
    const databasePath = join(root, "fleet.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(2, ?, '')")
      .run("002_compact_v1");
    database.close();

    expect(() => inspectJournalSchema(databasePath)).toThrow(/migration ledger sequence/i);
    expect(() => new SqliteJournalStore(databasePath)).toThrow(/migration ledger sequence/i);

    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    const rows = unchanged
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all();
    unchanged.close();
    expect(rows).toEqual([{ version: 2, checksum: "002_compact_v1" }]);
  });

  it("records an uncertainty boundary for every persisted active incarnation", async () => {
    const store = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(store);
    const id = "uncertain-agent" as AgentId;
    await adapter.createAgent({
      summary: {
        id,
        name: "uncertain",
        state: "idle",
        process: { state: "resident" },
        session: { id: "session-1", path: "/tmp/user-session.jsonl" },
      },
      launch: createLaunchProfile({ cwd: "/tmp", piArgv: [] }),
    });
    await store.putEpoch({
      agentId: id,
      epoch: 0 as ContinuityEpoch,
      state: "open",
      lastSafeEventPosition: 0,
      openedAt: "2026-01-01T00:00:00Z",
    });
    await store.putIncarnation({
      incarnationId: "unknown-incarnation" as IncarnationId,
      agentId: id,
      pid: null,
      state: "starting",
    });

    await reconcileObservationContinuity(store, "2026-01-01T00:01:00Z");

    await expect(store.getEpochs(id)).resolves.toMatchObject([
      { state: "closed", reason: "observation_uncertain" },
    ]);
    await expect(store.getAgentById(id)).resolves.toMatchObject({
      summary: {
        state: "failed",
        process: { state: "cleanup_uncertain" },
        error: { code: "incarnation_cleanup_uncertain" },
      },
    });
  });

  it("fails the control plane closed with content-safe storage errors", async () => {
    const store = new MemoryJournalStore();
    const service = new FleetService(new JournalFleetStoreAdapter(store));
    services.push(service);
    service.failStorage(new Error("PRIVATE_SQL_PAYLOAD"));
    await expect(service.list()).resolves.toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", message: "pi-fleet storage is unavailable." },
    });
    await expect(
      service.create({ name: "blocked", cwd: "/tmp", piArgv: [] }, "blocked-create"),
    ).resolves.toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  });

  it("rejects new destroy and receive work once clean shutdown closes admission", async () => {
    const store = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(store);
    const wakeup = new JournalWakeup();
    const journal = new JournalRuntimeComposition({
      store,
      limits: DEFAULT_RUNTIME_LIMITS,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup,
    });
    const service = new FleetService(adapter, { journal, journalStore: store });
    services.push(service);
    const created = await service.create({ name: "closing", cwd: "/tmp", piArgv: [] }, "create");
    expect(created.ok).toBe(true);
    const expectedAgentId = created.ok ? created.value.agent.id : "";

    service.beginShutdown();

    await expect(
      service.destroy({ name: "closing", expectedAgentId }, "destroy"),
    ).resolves.toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    await expect(
      service.prepareReceive(
        { name: "closing", expectedAgentId },
        { kind: "live" },
        false,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    await expect(adapter.getAgent("closing")).resolves.not.toBeNull();
  });

  it("keeps receive wakeups terminal after runtime closure", async () => {
    const wakeup = new JournalWakeup();
    const failure = Object.assign(new Error("closed"), { code: "runtime_unavailable" });
    wakeup.close(failure);
    await expect(
      wakeup.waitForEvents("closed-agent" as AgentId, 0, new AbortController().signal),
    ).rejects.toBe(failure);
  });

  it("keeps user launch profiles outside journal deletion", async () => {
    const store = new MemoryJournalStore();
    const adapter = new JournalFleetStoreAdapter(store);
    const id = "agent-1" as AgentId;
    await adapter.createAgent({
      summary: {
        id,
        name: "reviewer",
        state: "idle",
        process: { state: "absent" },
        session: { id: "session-1", path: "/tmp/user-session.jsonl" },
      },
      launch: createLaunchProfile({
        cwd: "/tmp",
        piArgv: ["--session", "/tmp/user-session.jsonl"],
      }),
    });
    await adapter.deleteAgent("reviewer", {
      operationId: "destroy-1",
      fingerprint: "destroy",
      destroyedAt: "2026-01-01T00:00:00Z",
    });
    expect(await store.getAgentByName("reviewer")).toBeNull();
    expect(await store.getDestroyReceipt("destroy-1")).toMatchObject({ agentId: id });
  });
});
