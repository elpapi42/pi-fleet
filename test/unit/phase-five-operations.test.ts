import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { initialProjectorState } from "../../src/runtime/lifecycle-projector.js";
import { JournalIngestionScheduler } from "../../src/runtime/journal-ingestion.js";
import { collectRuntimeJournalDiagnostics } from "../../src/runtime/runtime-diagnostics.js";
import type { AgentId, ContinuityEpoch, IncarnationId } from "../../src/runtime/semantic-events.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";
import { SqliteJournalStore } from "../../src/store/sqlite-journal-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const agentId = "agent-operations" as AgentId;
const incarnationId = "incarnation-1" as IncarnationId;
const epoch = 1 as ContinuityEpoch;

async function seededStore(path: string): Promise<SqliteJournalStore> {
  const store = new SqliteJournalStore(path, {
    checkpointCommitInterval: 1,
    reclaimPagesPerPass: 2,
    now: () => "2026-01-01T00:00:03.000Z",
  });
  await store.createAgent({
    agentId,
    name: "reviewer",
    summary: {
      id: agentId,
      name: "reviewer",
      state: "idle",
      process: { state: "absent" },
      session: { id: null, path: null },
    },
    launch: createLaunchProfile({ cwd: "/workspace", piArgv: [] }),
  });
  await store.putIncarnation({ incarnationId, agentId, pid: 123, state: "live" });
  await store.putEpoch({
    agentId,
    epoch,
    state: "open",
    lastSafeEventPosition: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());
  return store;
}

describe("Phase 5B journal operations", () => {
  it("runs bounded passive checkpoints and incremental reclamation without VACUUM", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase-five-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const store = await seededStore(path);

    await store.append({
      agentId,
      incarnationId,
      epoch,
      records: [
        {
          agentId,
          incarnationId: "incarnation-1" as IncarnationId,
          position: 1,
          observedAt: "2026-01-01T00:00:01.000Z",
          bytes: Buffer.from("{}\n"),
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
    });

    const checkpoint = (await store.getDiagnostics()).maintenance;
    expect(checkpoint).toMatchObject({
      state: "idle",
      lastCheckpointAt: "2026-01-01T00:00:03.000Z",
      autoVacuumMode: "incremental",
      requestedReclaimPages: 0,
    });
    expect(checkpoint.logFrames).toBeGreaterThanOrEqual(0);
    expect(checkpoint.checkpointedFrames).toBeGreaterThanOrEqual(0);

    await expect(store.maintain(-1)).rejects.toThrow(/non-negative integer/i);
    await expect(store.maintain(2)).resolves.toMatchObject({
      state: "idle",
      autoVacuumMode: "incremental",
      requestedReclaimPages: 2,
    });
    await store.close();
  });

  it("reports append failures as terminal content-free storage health", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase-five-failure-"));
    roots.push(root);
    const sqlite = await seededStore(join(root, "fleet.sqlite"));
    const memory = new MemoryJournalStore();
    await memory.createAgent({
      agentId,
      name: "reviewer",
      summary: {
        id: agentId,
        name: "reviewer",
        state: "idle",
        process: { state: "absent" },
        session: { id: null, path: null },
      },
      launch: createLaunchProfile({ cwd: "/workspace", piArgv: [] }),
    });
    await memory.putIncarnation({ incarnationId, agentId, pid: 123, state: "live" });
    await memory.putEpoch({
      agentId,
      epoch,
      state: "open",
      lastSafeEventPosition: 0,
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    await memory.beginIncarnation(agentId, incarnationId, epoch, initialProjectorState());

    for (const store of [memory, sqlite]) {
      await expect(
        store.append({
          agentId,
          incarnationId,
          epoch,
          records: [
            {
              agentId,
              incarnationId: "incarnation-failed" as IncarnationId,
              position: 2,
              observedAt: "2026-01-01T00:00:02.000Z",
              bytes: Buffer.from("secret append payload\n"),
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
      ).rejects.toThrow();
      const diagnostics = await store.getDiagnostics();
      expect(diagnostics.storageState).toBe("failed");
      expect(diagnostics.lastAppendDurationMs).toEqual(expect.any(Number));
      expect(JSON.stringify(diagnostics)).not.toContain("secret append payload");
    }

    await memory.close();
    await sqlite.close();
  });

  it("keeps SQLite diagnostics failed when recording failed health also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase-five-latch-"));
    roots.push(root);
    const path = join(root, "fleet.sqlite");
    const store = await seededStore(path);
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_runtime_health_failure
      BEFORE UPDATE OF storage_state ON journal_runtime_health
      WHEN NEW.storage_state = 'failed'
      BEGIN
        SELECT RAISE(FAIL, 'health marker unavailable');
      END;
    `);
    database.close();

    await expect(
      store.append({
        agentId,
        incarnationId,
        epoch,
        records: [
          {
            agentId,
            incarnationId: "incarnation-latched" as IncarnationId,
            position: 2,
            observedAt: "2026-01-01T00:00:02.000Z",
            bytes: Buffer.from("secret failed record\\n"),
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
    ).rejects.toThrow();

    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.storageState).toBe("failed");
    expect(JSON.stringify(diagnostics)).not.toContain("secret failed record");
    await store.close();
  });

  it("exposes content-free active diagnostics without paths or retained payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-phase-five-diagnostics-"));
    roots.push(root);
    const path = join(root, "secret-state", "fleet.sqlite");
    const store = await seededStore(path);
    const ingestion = new JournalIngestionScheduler({
      limits: {
        maxPendingRecords: 2,
        maxPendingBytes: 100,
        maxPendingBytesPerAgent: 100,
        maxBatchRecords: 2,
        maxBatchBytes: 100,
        maxBatchAgeMs: 100,
      },
      commit: async () => undefined,
    });

    const diagnostics = await collectRuntimeJournalDiagnostics({
      store,
      databasePath: path,
      ingestion,
      activeReceiveStreams: 2,
      activeReplayReads: 1,
    });
    expect(diagnostics).toMatchObject({
      files: {
        databaseBytes: expect.any(Number),
        walBytes: expect.any(Number),
        shmBytes: expect.any(Number),
      },
      retained: { agentCount: 1 },
      ingestion: { pendingRecords: 0, pendingBytes: 0 },
      append: { state: "healthy", lastCommitAt: null, lastDurationMs: null },
      activeReceiveStreams: 2,
      activeReplayReads: 1,
      checkpoint: { state: "idle" },
      continuityGapCount: 0,
      continuityUncertain: false,
    });
    const encoded = JSON.stringify(diagnostics);
    expect(encoded).not.toContain(root);
    expect(encoded).not.toContain("secret-state");
    expect(encoded).not.toContain("workspace");
    expect(encoded).not.toContain("reviewer");
    await store.close();
  });
});
