import { existsSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { OpaqueReceiveCursorCodec } from "../runtime/receive-pager.js";
import { createExternalPiTarget } from "../pi/external-target.js";
import { signalProcessTree, waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";
import { prepareFleetPathSecurity } from "../platform/shared/state-security.js";
import { startControlServer } from "../runtime/control-server.js";
import { FleetService } from "../runtime/fleet-service.js";
import { JournalRuntimeComposition } from "../runtime/journal-runtime.js";
import { JournalWakeup } from "../runtime/journal-wakeup.js";
import { preflightRuntimeStartup } from "../platform/shared/runtime-ownership.js";
import { CleanDrainCoordinator } from "../runtime/storage-health.js";
import { runtimeLimitsFromEnv } from "../shared/runtime-limits.js";
import { JournalFleetStoreAdapter } from "../store/journal-fleet-store-adapter.js";
import type { JournalStore } from "../store/journal-store.js";
import {
  classifyJournalMigrationRows,
  type JournalMigrationRow,
} from "../store/sqlite-journal-store.js";
import { WorkerJournalStore } from "../store/worker-journal-store.js";

export async function runRuntime(): Promise<void> {
  const paths = resolveFleetPaths();
  const limits = runtimeLimitsFromEnv();
  await preflightRuntimeStartup({ socketPath: paths.socketPath, destructive: false });
  await prepareFleetPathSecurity(paths);
  const schemaState = inspectJournalSchema(paths.databasePath);
  if (schemaState === "legacy") {
    await preflightRuntimeStartup({
      socketPath: paths.socketPath,
      destructive: true,
      assertOwnedProcessTreesAbsent: () => assertLegacyProcessTreesAbsent(paths.databasePath),
    });
  }

  let resolveService: (service: FleetService) => void;
  let rejectService: (error: unknown) => void;
  const serviceReady = new Promise<FleetService>((resolveReady, rejectReady) => {
    resolveService = resolveReady;
    rejectService = rejectReady;
  });
  const wakeup = new JournalWakeup();
  let journal: JournalRuntimeComposition | undefined;
  const server = await startControlServer({
    socketPath: paths.socketPath,
    service: serviceReady,
    journal: async () => {
      if (journal === undefined) throw new Error("Journal runtime is not ready");
      return journal;
    },
    limits,
  });

  let journalStore: WorkerJournalStore | undefined;
  let service: FleetService | undefined;
  try {
    journalStore = new WorkerJournalStore(paths.databasePath, {
      maxPending: limits.maxJournalPendingRecords,
      checkpointCommitInterval: limits.journalCheckpointCommitInterval,
      reclaimPagesPerPass: limits.journalReclaimPagesPerPass,
      onHealthFailure: (error) => {
        const failure = Object.assign(error, { code: "storage_unavailable" });
        wakeup.close(failure);
        service?.failStorage(failure);
      },
    });
    await reconcileObservationContinuity(journalStore, new Date().toISOString());
    journal = new JournalRuntimeComposition({
      store: journalStore,
      limits,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup,
      notifyEvents: (agentId, position) => wakeup.notify(agentId, position),
      failAgent: (agentId, error) => service?.failAgent(agentId, error),
    });
    const store = new JournalFleetStoreAdapter(journalStore);
    const piTarget = await createExternalPiTarget(
      process.env,
      limits.maxPiFrameBytes,
      limits.maxJournalPartialRecordBytes,
    );
    service = new FleetService(store, {
      launcher: piTarget.launcher,
      piIdentity: piTarget.identity,
      limits,
      journal,
      journalStore,
      onAgentDestroyed: (agentId) => {
        const error = new Error("Agent destroyed") as Error & { code: string };
        error.code = "agent_destroyed";
        wakeup.failAgent(agentId, error);
      },
    });
    await service.reconcile();
    resolveService!(service);
  } catch (error: unknown) {
    rejectService!(error);
    wakeup.close();
    await Promise.allSettled([service?.close() ?? Promise.resolve(), server.close()]);
    await journalStore?.close().catch(() => undefined);
    throw error;
  }

  const unavailable = Object.assign(new Error("Runtime unavailable"), {
    code: "runtime_unavailable",
  });
  const drain = new CleanDrainCoordinator({
    stopAdmission: () => service!.beginShutdown(),
    drainStdoutAndJournal: () => service!.drainStdoutAndJournal(),
    closeReceivers: async () => wakeup.close(unavailable),
    stopProcessTrees: () => service!.stopProcessTrees(),
    closeServer: () => server.close(),
    closeStore: () => journalStore!.close(),
  });
  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void drain.close().finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

export async function reconcileObservationContinuity(
  store: JournalStore,
  now: string,
): Promise<void> {
  for (const incarnation of await store.listActiveIncarnations()) {
    // Every persisted active incarnation may have outlived an unclean central-runtime death,
    // even if its process group is absent by the time recovery begins.
    let gone = incarnation.pid !== null && (await waitForProcessGroupExit(incarnation.pid, 0));
    const epochs = await store.getEpochs(incarnation.agentId);
    const open = epochs.findLast((epoch) => epoch.state === "open");
    if (open !== undefined) {
      const highWater = await store.getHighWater(incarnation.agentId);
      await store.putEpoch({
        ...open,
        state: "closed",
        lastSafeEventPosition: highWater?.eventPosition ?? open.lastSafeEventPosition,
        closedAt: now,
        reason: "observation_uncertain",
      });
    }

    if (!gone && incarnation.pid !== null) {
      signalProcessTree(incarnation.pid, "SIGTERM");
      gone = await waitForProcessGroupExit(incarnation.pid, 1_000);
    }
    if (!gone && incarnation.pid !== null) {
      signalProcessTree(incarnation.pid, "SIGKILL");
      gone = await waitForProcessGroupExit(incarnation.pid, 1_000);
    }
    await store.putIncarnation({
      ...incarnation,
      state: gone ? "gone" : "cleanup_uncertain",
    });
    const agent = await store.getAgentById(incarnation.agentId);
    if (agent === null) continue;
    const wasActive = agent.summary.state === "working" || agent.summary.state === "restoring";
    await store.putAgent({
      ...agent,
      summary: {
        ...agent.summary,
        state: gone && !wasActive ? "idle" : "failed",
        process: { state: gone ? "absent" : "cleanup_uncertain" },
        ...(!gone
          ? { error: { code: "incarnation_cleanup_uncertain" } }
          : wasActive
            ? { error: { code: "runtime_interrupted" } }
            : { error: undefined }),
      },
    });
  }
}

export type JournalSchemaState = "fresh" | "legacy" | "current";

export function inspectJournalSchema(path: string): JournalSchemaState {
  if (!existsSync(path) || statSync(path).size === 0) return "fresh";
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error: unknown) {
    throw new Error("pi-fleet database ownership is uncertain", { cause: error });
  }
  try {
    const table = database
      .prepare("SELECT type FROM sqlite_master WHERE name = 'schema_migrations'")
      .get() as { readonly type?: string } | undefined;
    if (table?.type !== "table") throw new Error("pi-fleet database migration ledger is missing");
    const rows = database
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all() as unknown as JournalMigrationRow[];
    const state = classifyJournalMigrationRows(rows);
    if (state === "fresh") throw new Error("pi-fleet database migration ledger is empty");
    return state;
  } finally {
    database.close();
  }
}

async function assertLegacyProcessTreesAbsent(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const database = new DatabaseSync(path, { readOnly: true });
  let pids: number[] = [];
  try {
    const rows = database
      .prepare(
        `SELECT json_extract(data_json, '$.pid') AS pid
         FROM incarnations
         WHERE state IN ('starting', 'live', 'stopping', 'cleanup_uncertain')`,
      )
      .all() as { pid?: number | null }[];
    if (
      rows.some(
        (row) => typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0,
      )
    ) {
      throw new Error("Legacy Pi process ownership is uncertain");
    }
    pids = rows.map((row) => row.pid as number);
  } finally {
    database.close();
  }
  for (const pid of pids) {
    if (!(await waitForProcessGroupExit(pid, 0))) {
      throw new Error(`Legacy Pi process group ${String(pid)} is still present`);
    }
  }
  assertNoOtherProcessHasDatabaseOpen(path);
}

export function assertNoOtherProcessHasDatabaseOpen(path: string, procRoot = "/proc"): void {
  if (process.platform !== "linux" || !existsSync(path)) {
    throw new Error("Legacy runtime ownership proof is supported only on Linux");
  }
  const databaseIdentity = statSync(path);
  const currentUid = process.getuid?.();
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const processPath = `${procRoot}/${entry}`;
    let owner: number;
    try {
      owner = statSync(processPath).uid;
    } catch {
      continue;
    }
    if (currentUid !== undefined && owner !== currentUid) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(`${processPath}/fd`);
    } catch (error: unknown) {
      throw new Error(`Cannot prove legacy runtime ${entry} released pi-fleet state`, {
        cause: error,
      });
    }
    for (const descriptor of descriptors) {
      try {
        const opened = statSync(`${processPath}/fd/${descriptor}`);
        if (opened.dev === databaseIdentity.dev && opened.ino === databaseIdentity.ino) {
          throw new Error(`Legacy runtime process ${entry} still owns the pi-fleet database`);
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EBADF")
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRuntime();
}
