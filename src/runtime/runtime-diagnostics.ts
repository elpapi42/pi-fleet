import { stat } from "node:fs/promises";

import type {
  JournalAgentStorageDiagnostics,
  JournalMaintenanceResult,
  JournalStore,
} from "../store/journal-store.js";

interface IngestionDiagnosticsSource {
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly oldestPendingAgeMs: number;
  readonly pausedAgentCount: number;
  readonly failedAgentCount: number;
}

export interface RuntimeJournalDiagnostics {
  readonly files: {
    readonly databaseBytes: number;
    readonly walBytes: number;
    readonly shmBytes: number;
  };
  readonly retained: {
    readonly agentCount: number;
    readonly rawRecordCount: number;
    readonly rawBytes: number;
    readonly semanticEventCount: number;
  };
  readonly retainedByAgent: readonly JournalAgentStorageDiagnostics[];
  readonly ingestion: {
    readonly pendingRecords: number;
    readonly pendingBytes: number;
    readonly oldestPendingAgeMs: number;
    readonly pausedAgentCount: number;
    readonly failedAgentCount: number;
  };
  readonly append: {
    readonly state: "healthy" | "failed";
    readonly lastCommitAt: string | null;
    readonly lastDurationMs: number | null;
  };
  readonly openProjectorActivities: number;
  readonly activeReceiveStreams: number;
  readonly activeReplayReads: number;
  readonly checkpoint: JournalMaintenanceResult;
  readonly continuityGapCount: number;
  readonly continuityUncertain: boolean;
}

export async function collectRuntimeJournalDiagnostics(options: {
  readonly store: JournalStore;
  readonly databasePath: string;
  readonly ingestion: IngestionDiagnosticsSource;
  readonly activeReceiveStreams: number;
  readonly activeReplayReads: number;
}): Promise<RuntimeJournalDiagnostics> {
  const storage = await options.store.getDiagnostics();
  const [databaseBytes, walBytes, shmBytes] = await Promise.all([
    fileBytes(options.databasePath),
    fileBytes(`${options.databasePath}-wal`),
    fileBytes(`${options.databasePath}-shm`),
  ]);
  return {
    files: { databaseBytes, walBytes, shmBytes },
    retained: {
      agentCount: storage.agentCount,
      rawRecordCount: storage.rawRecordCount,
      rawBytes: storage.rawBytes,
      semanticEventCount: storage.semanticEventCount,
    },
    retainedByAgent: storage.retainedByAgent,
    ingestion: {
      pendingRecords: options.ingestion.pendingRecords,
      pendingBytes: options.ingestion.pendingBytes,
      oldestPendingAgeMs: options.ingestion.oldestPendingAgeMs,
      pausedAgentCount: options.ingestion.pausedAgentCount,
      failedAgentCount: options.ingestion.failedAgentCount,
    },
    append: {
      state: storage.storageState,
      lastCommitAt: storage.lastCommitAt,
      lastDurationMs: storage.lastAppendDurationMs,
    },
    openProjectorActivities: storage.openProjectorActivities,
    activeReceiveStreams: options.activeReceiveStreams,
    activeReplayReads: options.activeReplayReads,
    checkpoint: storage.maintenance,
    continuityGapCount: storage.continuityGapCount,
    continuityUncertain: storage.continuityGapCount > 0,
  };
}

async function fileBytes(path: string): Promise<number> {
  const value = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return value?.size ?? 0;
}
