import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { initialProjectorState } from "../../src/runtime/lifecycle-projector.js";
import type {
  AgentEventId,
  AgentId,
  ActivityId,
  ContinuityEpoch,
  IncarnationId,
  ReceiveCursor,
} from "../../src/runtime/semantic-events.js";
import type { FleetStore, StoredAgent } from "../../src/store/fleet-store.js";
import type { JournalAgent, JournalStore } from "../../src/store/journal-store.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";
import { SqliteFleetStore } from "../../src/store/sqlite-store.js";
import { SqliteJournalStore } from "../../src/store/sqlite-journal-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const agentId = "agent-1" as AgentId;
const incarnationId = "incarnation-1" as IncarnationId;
const epoch = 1 as ContinuityEpoch;

function agent(name = "reviewer", id = agentId): JournalAgent {
  return {
    agentId: id,
    name,
    summary: {
      id,
      name,
      state: "idle",
      process: { state: "absent" },
      session: { id: null, path: null },
    },
    launch: createLaunchProfile({ cwd: "/workspace", piArgv: [] }),
  };
}

function legacyAgent(sessionPath: string): StoredAgent {
  const current = agent();
  return {
    summary: {
      ...current.summary,
      session: { id: "session-1", path: sessionPath },
    },
    launch: current.launch,
  };
}

async function createLegacyDatabase(path: string, sessionPath: string): Promise<void> {
  const store: FleetStore = new SqliteFleetStore(path);
  await store.createAgent(legacyAgent(sessionPath));
  await store.putOperation({
    operationId: "legacy-operation",
    method: "send",
    fingerprint: "legacy",
    targetName: "reviewer",
    state: "completed",
    result: { ok: true },
  });
  await store.close();
}

async function exerciseJournalStore(store: JournalStore): Promise<void> {
  await expect(
    store.createAgent({
      ...agent(),
      summary: { ...agent().summary, id: "another-agent" },
    }),
  ).rejects.toThrow(/identity does not match/i);
  expect(await store.createAgent(agent())).toBe(true);
  expect(await store.createAgent(agent("reviewer", "agent-2" as AgentId))).toBe(false);
  expect(await store.getAgentByName("reviewer")).toEqual(agent());
  expect(await store.getAgentById(agentId)).toEqual(agent());

  await store.putOperation({
    operationId: "operation-1",
    agentId,
    targetName: "reviewer",
    method: "send",
    fingerprint: "fingerprint",
    state: "pending",
    result: null,
  });
  await store.putSend({
    sendId: "send-1",
    agentId,
    ordinal: 1,
    message: "hello",
    delivery: "steer",
    state: "pending",
    acceptedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.putCompact({
    compactId: "compact-1",
    agentId,
    state: "pending",
    requestedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.putIncarnation({
    incarnationId,
    agentId,
    pid: 123,
    state: "live",
  });
  expect(await store.getOperation("operation-1")).toMatchObject({ agentId, state: "pending" });
  expect(await store.listPendingOperations()).toHaveLength(1);
  expect(await store.getSend("send-1")).toMatchObject({ agentId, ordinal: 1 });
  expect(await store.nextSendOrdinal(agentId)).toBe(2);
  expect(await store.listNonterminalSends()).toHaveLength(1);
  expect(await store.getCompact("compact-1")).toMatchObject({ agentId, state: "pending" });
  expect(await store.listNonterminalCompacts()).toHaveLength(1);
  expect(await store.listActiveIncarnations()).toHaveLength(1);
  await store.putEpoch({
    agentId,
    epoch,
    state: "open",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());

  const bytes = Buffer.from([0xff, 0x00, 0x0d, 0x0a]);
  await store.append({
    agentId,
    incarnationId,
    epoch,
    records: [
      {
        agentId,
        incarnationId,
        position: 1,
        observedAt: "2026-01-01T00:00:01.000Z",
        bytes,
      },
    ],
    events: [
      {
        agentId,
        position: 1,
        event: {
          id: "event-1" as AgentEventId,
          activityId: "activity-1" as ActivityId,
          agentId,
          cursor: "cursor-1" as ReceiveCursor,
          epoch,
          sourceRawPosition: 1,
          observedAt: "2026-01-01T00:00:01.000Z",
          type: "assistant.message.finished",
          text: "done",
        },
      },
    ],
    projectorState: {
      version: 1,
      messageSequence: 0,
      finishedThinkingIndexes: [],
      openActivities: [],
    },
    highWater: { rawPosition: 1, eventPosition: 1, idleEventPosition: 1 },
  });

  expect(await store.getRawRecords(agentId, 0, 10)).toEqual([
    expect.objectContaining({ position: 1, bytes }),
  ]);
  expect(
    await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    }),
  ).toEqual([
    expect.objectContaining({ position: 1, event: expect.objectContaining({ text: "done" }) }),
  ]);
  expect(await store.getProjectorState(agentId, incarnationId, epoch)).toEqual({
    version: 1,
    messageSequence: 0,
    finishedThinkingIndexes: [],
    openActivities: [],
  });
  expect(await store.getHighWater(agentId)).toEqual({
    rawPosition: 1,
    eventPosition: 1,
    idleEventPosition: 1,
  });
  await expect(
    store.append({
      agentId,
      incarnationId,
      epoch,
      records: [],
      events: [
        {
          agentId,
          position: 2,
          event: {
            id: "event-cross-epoch-source" as AgentEventId,
            activityId: "activity-cross-epoch-source" as ActivityId,
            agentId,
            cursor: "cursor-cross-epoch-source" as ReceiveCursor,
            epoch,
            sourceRawPosition: 1,
            observedAt: "2026-01-01T00:00:02.000Z",
            type: "assistant.message.finished",
            text: "invalid provenance",
          },
        },
      ],
      projectorState: {
        version: 1,
        messageSequence: 1,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 1, eventPosition: 2, idleEventPosition: 1 },
    }),
  ).rejects.toThrow(/same append and epoch/i);
  expect(await store.openReceive(agentId)).toEqual({
    agent: agent(),
    epochs: [
      {
        agentId,
        epoch,
        state: "open",
        lastSafeEventPosition: 0,
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    highWater: { rawPosition: 1, eventPosition: 1, idleEventPosition: 1 },
  });
  expect(await store.getDiagnostics()).toEqual({
    rawRecordCount: 1,
    rawBytes: bytes.byteLength,
    semanticEventCount: 1,
    agentCount: 1,
    retainedByAgent: [
      { agentId, rawRecordCount: 1, rawBytes: bytes.byteLength, semanticEventCount: 1 },
    ],
    openProjectorActivities: 0,
    continuityGapCount: 0,
    storageState: "failed",
    lastCommitAt: expect.any(String),
    lastAppendDurationMs: expect.any(Number),
    maintenance: {
      state: "idle",
      lastCheckpointAt: null,
      busy: false,
      logFrames: 0,
      checkpointedFrames: 0,
      autoVacuumMode: "none",
      freelistPagesBefore: 0,
      freelistPagesAfter: 0,
      requestedReclaimPages: 0,
    },
  });

  expect(
    await store.destroyAgent(agentId, {
      operationId: "destroy-1",
      agentId,
      agentName: "reviewer",
      fingerprint: "destroy-fingerprint",
      destroyedAt: "2026-01-01T00:01:00.000Z",
      status: "destroyed",
    }),
  ).toEqual(agent());
  expect(await store.getAgentById(agentId)).toBeNull();
  expect(await store.getOperation("operation-1")).toBeNull();
  expect(await store.getRawRecords(agentId, 0, 10)).toEqual([]);
  expect(
    await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    }),
  ).toEqual([]);
  expect(await store.getDestroyReceipt("destroy-1")).toEqual({
    operationId: "destroy-1",
    agentId,
    agentName: "reviewer",
    fingerprint: "destroy-fingerprint",
    destroyedAt: "2026-01-01T00:01:00.000Z",
    status: "destroyed",
  });
  const replacementId = "agent-2" as AgentId;
  expect(await store.createAgent(agent("reviewer", replacementId))).toBe(true);
  await expect(
    store.destroyAgent(replacementId, {
      operationId: "destroy-1",
      agentId: replacementId,
      agentName: "reviewer",
      fingerprint: "reused-operation",
      destroyedAt: "2026-01-01T00:02:00.000Z",
      status: "destroyed",
    }),
  ).rejects.toThrow(/already used/i);
  expect(await store.getAgentById(replacementId)).not.toBeNull();
}

async function exerciseOwnershipAndAtomicity(store: JournalStore): Promise<void> {
  const secondAgentId = "agent-2" as AgentId;
  await store.createAgent(agent());
  await store.createAgent(agent("planner", secondAgentId));
  await store.putOperation({
    operationId: "operation-1",
    agentId,
    targetName: "reviewer",
    method: "send",
    fingerprint: "first",
    state: "pending",
    result: null,
  });
  await expect(
    store.putOperation({
      operationId: "operation-1",
      agentId: secondAgentId,
      targetName: "planner",
      method: "send",
      fingerprint: "retargeted",
      state: "pending",
      result: null,
    }),
  ).rejects.toThrow(/cannot change generations/i);
  expect(await store.getOperation("operation-1")).toMatchObject({ agentId, fingerprint: "first" });

  await store.putIncarnation({ incarnationId, agentId, pid: 123, state: "live" });
  await store.putEpoch({
    agentId,
    epoch,
    state: "open",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());
  await expect(
    store.append({
      agentId,
      incarnationId,
      epoch,
      records: [
        {
          agentId,
          incarnationId,
          position: 2,
          observedAt: "2026-01-01T00:00:00.000Z",
          bytes: Buffer.from("invalid\n"),
        },
      ],
      events: [],
      projectorState: {
        version: 1,
        messageSequence: 0,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 2, eventPosition: 0, idleEventPosition: null },
    }),
  ).rejects.toThrow(/not contiguous/i);
  expect(await store.getRawRecords(agentId, 0, 10)).toEqual([]);
  expect(await store.getProjectorState(agentId, incarnationId, epoch)).toEqual({
    version: 1,
    messageSequence: 0,
    finishedThinkingIndexes: [],
    openActivities: [],
  });

  await store.putEpoch({
    agentId,
    epoch,
    state: "closed",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:00:01.000Z",
    reason: "observation_uncertain",
  });
  await expect(
    store.append({
      agentId,
      incarnationId,
      epoch,
      records: [
        {
          agentId,
          incarnationId,
          position: 1,
          observedAt: "2026-01-01T00:00:02.000Z",
          bytes: Buffer.from("late\\n"),
        },
      ],
      events: [],
      projectorState: {
        version: 1,
        messageSequence: 0,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 1, eventPosition: 0, idleEventPosition: null },
    }),
  ).rejects.toThrow(/closed continuity epoch/i);
  expect(await store.getRawRecords(agentId, 0, 10)).toEqual([]);
  expect(
    await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    }),
  ).toEqual([]);
  expect(await store.getProjectorState(agentId, incarnationId, epoch)).toEqual({
    version: 1,
    messageSequence: 0,
    finishedThinkingIndexes: [],
    openActivities: [],
  });
  expect(await store.getHighWater(agentId)).toBeNull();
}

async function exerciseBoundedEventReads(store: JournalStore): Promise<void> {
  await store.createAgent(agent());
  await store.putIncarnation({ incarnationId, agentId, pid: 123, state: "live" });
  await store.putEpoch({
    agentId,
    epoch,
    state: "open",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());
  const events = [1, 2].map((position) => ({
    agentId,
    position,
    event: {
      id: `event-${position}` as AgentEventId,
      activityId: `activity-${position}` as ActivityId,
      agentId,
      cursor: `cursor-${position}` as ReceiveCursor,
      epoch,
      sourceRawPosition: position,
      observedAt: "2026-01-01T00:00:00.000Z",
      type: "assistant.message.finished" as const,
      text: "x".repeat(256),
    },
  }));
  await store.append({
    agentId,
    incarnationId,
    epoch,
    records: [1, 2].map((position) => ({
      agentId,
      incarnationId,
      position,
      observedAt: "2026-01-01T00:00:00.000Z",
      bytes: Buffer.from("{}\n"),
    })),
    events,
    projectorState: {
      version: 1,
      messageSequence: 1,
      finishedThinkingIndexes: [],
      openActivities: [],
    },
    highWater: { rawPosition: 2, eventPosition: 2, idleEventPosition: 2 },
  });

  const firstBytes = Buffer.byteLength(JSON.stringify(events[0]));
  expect(
    await store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: firstBytes,
      maxEventBytes: 10_000,
    }),
  ).toEqual([events[0]]);
  expect(
    await store.readEvents({
      agentId,
      epoch,
      afterPosition: 1,
      limit: 10,
      maxBytes: firstBytes,
      maxEventBytes: 10_000,
    }),
  ).toEqual([events[1]]);
  await expect(
    store.readEvents({
      agentId,
      epoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: firstBytes,
      maxEventBytes: 1,
    }),
  ).rejects.toThrow(/storage read limit/i);
}

describe("dormant JournalStore", () => {
  it("keeps UUID-owned history atomic and isolates same-name generations in memory", async () => {
    const store = new MemoryJournalStore();
    await exerciseJournalStore(store);
    await store.close();
  });

  it("persists UUID-owned history in the inactive SQLite store", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-store-"));
    roots.push(root);
    const store = new SqliteJournalStore(join(root, "fleet.sqlite"));
    await exerciseJournalStore(store);
    await store.close();
  });

  it("persists pre-target receipts and atomically binds create generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-operation-receipt-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const pending = {
      operationId: "create-operation",
      agentId: null,
      targetName: "reviewer",
      method: "create" as const,
      fingerprint: '{"name":"reviewer"}',
      state: "pending" as const,
      result: null,
    };
    let store = new SqliteJournalStore(path);
    await store.putOperation(pending);
    await store.close();

    store = new SqliteJournalStore(path);
    expect(await store.getOperation(pending.operationId)).toEqual(pending);
    const targeted = { ...pending, agentId };
    expect(await store.createAgentWithOperation(agent(), targeted)).toBe(true);
    expect(await store.getAgentById(agentId)).toEqual(agent());
    expect(await store.getOperation(pending.operationId)).toEqual(targeted);

    await store.putOperation({
      operationId: "occupied-create",
      agentId: null,
      targetName: "reviewer",
      method: "create",
      fingerprint: "occupied",
      state: "pending",
      result: null,
    });
    expect(
      await store.createAgentWithOperation(agent("reviewer", "another" as AgentId), {
        operationId: "occupied-create",
        agentId: "another" as AgentId,
        targetName: "reviewer",
        method: "create",
        fingerprint: "occupied",
        state: "pending",
        result: null,
      }),
    ).toBe(false);
    expect(await store.getOperation("occupied-create")).toMatchObject({ agentId: null });
    await store.close();
  });

  it("rolls provisional create back atomically while preserving its terminal receipt", async () => {
    const pending = {
      operationId: "rollback-create",
      agentId,
      targetName: "reviewer",
      method: "create" as const,
      fingerprint: "sha256:rollback",
      state: "pending" as const,
      result: null,
    };
    const completed = {
      ...pending,
      agentId: null,
      state: "completed" as const,
      result: { ok: false, error: { code: "pi_start_failed" } },
    };

    const memory = new MemoryJournalStore();
    expect(await memory.createAgentWithOperation(agent(), pending)).toBe(true);
    await expect(memory.rollbackProvisionalCreate(agentId, completed)).resolves.toEqual(agent());
    expect(await memory.getAgentById(agentId)).toBeNull();
    expect(await memory.getOperation(pending.operationId)).toEqual(completed);
    await memory.close();

    const root = await mkdtemp(join(tmpdir(), "pifleet-create-rollback-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const sqlite = new SqliteJournalStore(path);
    expect(await sqlite.createAgentWithOperation(agent(), pending)).toBe(true);
    const fault = new DatabaseSync(path);
    fault.exec(`
      CREATE TRIGGER reject_provisional_delete
      BEFORE DELETE ON journal_agents
      BEGIN
        SELECT RAISE(FAIL, 'injected rollback failure');
      END;
    `);
    await expect(sqlite.rollbackProvisionalCreate(agentId, completed)).rejects.toThrow(
      /injected rollback failure/i,
    );
    expect(await sqlite.getAgentById(agentId)).toEqual(agent());
    expect(await sqlite.getOperation(pending.operationId)).toEqual(pending);
    fault.exec("DROP TRIGGER reject_provisional_delete");
    fault.close();
    await expect(sqlite.rollbackProvisionalCreate(agentId, completed)).resolves.toEqual(agent());
    expect(await sqlite.getAgentById(agentId)).toBeNull();
    expect(await sqlite.getOperation(pending.operationId)).toEqual(completed);
    await sqlite.close();
  });

  it("bounds event reads before returning rows from memory and SQLite", async () => {
    const memory = new MemoryJournalStore();
    await exerciseBoundedEventReads(memory);
    await memory.close();

    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-bounded-read-"));
    roots.push(root);
    const sqlite = new SqliteJournalStore(join(root, "fleet.sqlite"));
    await exerciseBoundedEventReads(sqlite);
    await sqlite.close();
  });

  it("enforces immutable ownership and atomic append in memory and SQLite", async () => {
    const memory = new MemoryJournalStore();
    await exerciseOwnershipAndAtomicity(memory);
    await memory.close();

    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-atomic-"));
    roots.push(root);
    const sqlite = new SqliteJournalStore(join(root, "fleet.sqlite"));
    await exerciseOwnershipAndAtomicity(sqlite);
    await sqlite.close();
  });

  it("transactionally resets schema v2 without touching native sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-reset-"));
    roots.push(root);
    const databasePath = join(root, "fleet.sqlite");
    const sessionPath = join(root, "native-session.jsonl");
    const sessionBytes = Buffer.from('{"type":"session"}\n');
    await writeFile(sessionPath, sessionBytes);
    await createLegacyDatabase(databasePath, sessionPath);

    const store = new SqliteJournalStore(databasePath);
    expect(await store.listAgents()).toEqual([]);
    expect(await store.getOperation("legacy-operation")).toBeNull();
    await store.close();
    expect(await readFile(sessionPath)).toEqual(sessionBytes);

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("SELECT version, checksum FROM schema_migrations").all()).toEqual([
      { version: 3, checksum: "003_uuid_journal_v3" },
    ]);
    inspected.close();
  });

  it("rolls back a failed destructive schema replacement to intact schema v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-journal-rollback-"));
    roots.push(root);
    const databasePath = join(root, "fleet.sqlite");
    const sessionPath = join(root, "native-session.jsonl");
    await writeFile(sessionPath, "session\n");
    await createLegacyDatabase(databasePath, sessionPath);
    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec("CREATE VIEW journal_agents AS SELECT agent_id, name, data_json FROM agents");
    incompatible.close();

    expect(() => new SqliteJournalStore(databasePath)).toThrow();

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("SELECT name FROM agents").all()).toEqual([{ name: "reviewer" }]);
    expect(
      inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 2 });
    inspected.close();
  });
});
