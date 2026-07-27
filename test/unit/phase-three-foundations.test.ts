import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertTrustedDirectoryAncestor,
  prepareFleetPathSecurity,
} from "../../src/platform/shared/state-security.js";
import { JournalIngestionScheduler } from "../../src/runtime/journal-ingestion.js";
import { collectRuntimeJournalDiagnostics } from "../../src/runtime/runtime-diagnostics.js";
import {
  preflightRuntimeStartup,
  RuntimeOwnershipBlockedError,
} from "../../src/platform/shared/runtime-ownership.js";
import {
  CleanDrainCoordinator,
  StorageHealthController,
} from "../../src/runtime/storage-health.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";
import { SqliteJournalStore } from "../../src/store/sqlite-journal-store.js";
import { SqliteFleetStore } from "../../src/store/sqlite-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pifleet-phase-three-"));
  roots.push(value);
  return value;
}

describe("Phase 3 safety foundations", () => {
  it("creates private state paths and rejects symlink path components", async () => {
    const base = await root();
    const paths = {
      runtimeRoot: join(base, "runtime"),
      stateRoot: join(base, "state"),
      socketPath: join(base, "runtime", "control.sock"),
      databasePath: join(base, "state", "fleet.sqlite"),
    };
    await prepareFleetPathSecurity(paths);
    expect((await lstat(paths.runtimeRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.databasePath)).mode & 0o777).toBe(0o600);

    const target = join(base, "target");
    await rm(paths.stateRoot, { recursive: true, force: true });
    await mkdir(target);
    await symlink(target, paths.stateRoot);
    await expect(prepareFleetPathSecurity(paths)).rejects.toThrow(/unsafe pi-fleet directory/i);

    const ancestor = join(base, "linked-parent");
    await symlink(target, ancestor);
    await expect(
      prepareFleetPathSecurity({
        ...paths,
        stateRoot: join(ancestor, "nested"),
        databasePath: join(ancestor, "nested", "fleet.sqlite"),
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it("accepts only trusted state-root ancestor ownership and mutability", () => {
    expect(() => assertTrustedDirectoryAncestor("/home/user", 1000, 0o40755, 1000)).not.toThrow();
    expect(() => assertTrustedDirectoryAncestor("/usr", 0, 0o40755, 1000)).not.toThrow();
    expect(() => assertTrustedDirectoryAncestor("/tmp", 0, 0o41777, 1000)).not.toThrow();
    expect(() => assertTrustedDirectoryAncestor("/var/tmp", 0, 0o41777, 1000)).not.toThrow();
    expect(() => assertTrustedDirectoryAncestor("/shared", 2000, 0o40700, 1000)).toThrow(
      /untrusted.*ancestor/i,
    );
    expect(() => assertTrustedDirectoryAncestor("/shared", 0, 0o40777, 1000)).toThrow(
      /untrusted.*ancestor/i,
    );
    expect(() => assertTrustedDirectoryAncestor("/other-sticky", 0, 0o41777, 1000)).toThrow(
      /untrusted.*ancestor/i,
    );
  });

  it("hardens SQLite sidecars created after WAL activation", async () => {
    const base = await root();
    const previousUmask = process.umask(0);
    const paths = [join(base, "active", "fleet.sqlite"), join(base, "journal", "fleet.sqlite")];
    let active: SqliteFleetStore | undefined;
    let journal: SqliteJournalStore | undefined;
    try {
      active = new SqliteFleetStore(paths[0] as string);
      journal = new SqliteJournalStore(paths[1] as string);
      for (const databasePath of paths) {
        for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          expect((await lstat(candidate)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      process.umask(previousUmask);
      await Promise.all([active?.close(), journal?.close()]);
    }
  });

  it("blocks responsive, uncertain, and unproven destructive startup before mutation", async () => {
    const base = await root();
    const socketPath = join(base, "control.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await expect(
      preflightRuntimeStartup({ socketPath, destructive: false }),
    ).rejects.toBeInstanceOf(RuntimeOwnershipBlockedError);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(
      preflightRuntimeStartup({
        socketPath,
        destructive: false,
        inspectOwnership: async () => "uncertain",
      }),
    ).rejects.toThrow(/ownership.*uncertain/i);

    await expect(
      preflightRuntimeStartup({ socketPath: join(base, "absent.sock"), destructive: true }),
    ).rejects.toThrow(/requires proof/i);
    let proved = false;
    await expect(
      preflightRuntimeStartup({
        socketPath: join(base, "absent.sock"),
        destructive: true,
        assertOwnedProcessTreesAbsent: async () => {
          proved = true;
        },
      }),
    ).resolves.toBe("absent");
    expect(proved).toBe(true);
  });

  it("runs clean drain once in the required order", async () => {
    const order: string[] = [];
    const coordinator = new CleanDrainCoordinator({
      stopAdmission: () => {
        order.push("admission");
      },
      drainStdoutAndJournal: async () => void order.push("journal"),
      closeReceivers: async () => void order.push("receivers"),
      stopProcessTrees: async () => void order.push("processes"),
      closeServer: async () => void order.push("server"),
      closeStore: async () => void order.push("store"),
    });
    await Promise.all([coordinator.close(), coordinator.close()]);
    expect(order).toEqual(["admission", "journal", "receivers", "processes", "server", "store"]);
  });

  it("attempts every clean-drain step while preserving the first failure", async () => {
    const order: string[] = [];
    const coordinator = new CleanDrainCoordinator({
      stopAdmission: () => {
        order.push("admission");
        throw new Error("admission failed");
      },
      drainStdoutAndJournal: async () => void order.push("journal"),
      closeReceivers: async () => void order.push("receivers"),
      stopProcessTrees: async () => void order.push("processes"),
      closeServer: async () => void order.push("server"),
      closeStore: async () => void order.push("store"),
    });
    await expect(coordinator.close()).rejects.toThrow("admission failed");
    expect(order).toEqual(["admission", "journal", "receivers", "processes", "server", "store"]);
  });

  it("publishes the first terminal storage failure without payload data", () => {
    const health = new StorageHealthController();
    const seen: string[] = [];
    health.onChange((value) => seen.push(value.state));
    health.fail(new Error("disk unavailable"), null);
    health.fail(new Error("secret payload"), null);
    expect(seen).toEqual(["failed"]);
    expect(health.health).toMatchObject({ state: "failed", lastDurableCursor: null });
  });

  it("collects content-free file, store, and ingestion diagnostics", async () => {
    const base = await root();
    const databasePath = join(base, "fleet.sqlite");
    await writeFile(databasePath, "1234");
    await writeFile(`${databasePath}-wal`, "12");
    await chmod(databasePath, 0o600);
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
      store: new MemoryJournalStore(),
      databasePath,
      ingestion,
      activeReceiveStreams: 3,
      activeReplayReads: 1,
    });
    expect(diagnostics).toMatchObject({
      files: { databaseBytes: 4, walBytes: 2, shmBytes: 0 },
      ingestion: { pendingRecords: 0, pendingBytes: 0 },
      activeReceiveStreams: 3,
      activeReplayReads: 1,
      append: { state: "healthy", lastCommitAt: null, lastDurationMs: null },
      checkpoint: { state: "idle", lastCheckpointAt: null },
      continuityGapCount: 0,
      continuityUncertain: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });
});
