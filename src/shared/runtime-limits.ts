const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export interface RuntimeLimits {
  readonly maxResidentProcesses: number;
  readonly maxMessageBytes: number;
  readonly maxProtocolFrameBytes: number;
  readonly maxPiFrameBytes: number;
  readonly maxJournalPendingRecords: number;
  readonly maxJournalPendingBytes: number;
  readonly maxJournalPendingBytesPerAgent: number;
  readonly maxJournalPartialRecordBytes: number;
  readonly maxJournalBatchRecords: number;
  readonly maxJournalBatchBytes: number;
  readonly maxJournalBatchAgeMs: number;
  readonly journalCheckpointCommitInterval: number;
  readonly journalReclaimPagesPerPass: number;
  readonly maxOpenProjectorActivities: number;
  readonly maxReceiveStreams: number;
  readonly maxReceiveReplayRows: number;
  readonly maxReceiveReplayBytes: number;
  readonly maxSemanticFrameBytes: number;
  readonly maxSemanticSegments: number;
  readonly maxSocketWriteMs: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxResidentProcesses: 32,
  maxMessageBytes: 512 * KIBIBYTE,
  maxProtocolFrameBytes: MEBIBYTE,
  maxPiFrameBytes: 8 * MEBIBYTE,
  maxJournalPendingRecords: 4_096,
  maxJournalPendingBytes: 32 * MEBIBYTE,
  maxJournalPendingBytesPerAgent: 4 * MEBIBYTE,
  maxJournalPartialRecordBytes: 8 * MEBIBYTE,
  maxJournalBatchRecords: 128,
  maxJournalBatchBytes: 512 * KIBIBYTE,
  maxJournalBatchAgeMs: 25,
  journalCheckpointCommitInterval: 128,
  journalReclaimPagesPerPass: 32,
  maxOpenProjectorActivities: 1_024,
  maxReceiveStreams: 128,
  maxReceiveReplayRows: 256,
  maxReceiveReplayBytes: 4 * MEBIBYTE,
  maxSemanticFrameBytes: MEBIBYTE,
  maxSemanticSegments: 4_096,
  maxSocketWriteMs: 30_000,
});

const ENV_KEYS: Readonly<Record<keyof RuntimeLimits, string>> = {
  maxResidentProcesses: "PIFLEET_MAX_RESIDENT_PROCESSES",
  maxMessageBytes: "PIFLEET_MAX_MESSAGE_BYTES",
  maxProtocolFrameBytes: "PIFLEET_MAX_PROTOCOL_FRAME_BYTES",
  maxPiFrameBytes: "PIFLEET_MAX_PI_FRAME_BYTES",
  maxJournalPendingRecords: "PIFLEET_MAX_JOURNAL_PENDING_RECORDS",
  maxJournalPendingBytes: "PIFLEET_MAX_JOURNAL_PENDING_BYTES",
  maxJournalPendingBytesPerAgent: "PIFLEET_MAX_JOURNAL_PENDING_BYTES_PER_AGENT",
  maxJournalPartialRecordBytes: "PIFLEET_MAX_JOURNAL_PARTIAL_RECORD_BYTES",
  maxJournalBatchRecords: "PIFLEET_MAX_JOURNAL_BATCH_RECORDS",
  maxJournalBatchBytes: "PIFLEET_MAX_JOURNAL_BATCH_BYTES",
  maxJournalBatchAgeMs: "PIFLEET_MAX_JOURNAL_BATCH_AGE_MS",
  journalCheckpointCommitInterval: "PIFLEET_JOURNAL_CHECKPOINT_COMMIT_INTERVAL",
  journalReclaimPagesPerPass: "PIFLEET_JOURNAL_RECLAIM_PAGES_PER_PASS",
  maxOpenProjectorActivities: "PIFLEET_MAX_OPEN_PROJECTOR_ACTIVITIES",
  maxReceiveStreams: "PIFLEET_MAX_RECEIVE_STREAMS",
  maxReceiveReplayRows: "PIFLEET_MAX_RECEIVE_REPLAY_ROWS",
  maxReceiveReplayBytes: "PIFLEET_MAX_RECEIVE_REPLAY_BYTES",
  maxSemanticFrameBytes: "PIFLEET_MAX_SEMANTIC_FRAME_BYTES",
  maxSemanticSegments: "PIFLEET_MAX_SEMANTIC_SEGMENTS",
  maxSocketWriteMs: "PIFLEET_MAX_SOCKET_WRITE_MS",
};

export function runtimeLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return {
    maxResidentProcesses: positiveInteger(env, "maxResidentProcesses"),
    maxMessageBytes: positiveInteger(env, "maxMessageBytes"),
    maxProtocolFrameBytes: positiveInteger(env, "maxProtocolFrameBytes"),
    maxPiFrameBytes: positiveInteger(env, "maxPiFrameBytes"),
    maxJournalPendingRecords: positiveInteger(env, "maxJournalPendingRecords"),
    maxJournalPendingBytes: positiveInteger(env, "maxJournalPendingBytes"),
    maxJournalPendingBytesPerAgent: positiveInteger(env, "maxJournalPendingBytesPerAgent"),
    maxJournalPartialRecordBytes: positiveInteger(env, "maxJournalPartialRecordBytes"),
    maxJournalBatchRecords: positiveInteger(env, "maxJournalBatchRecords"),
    maxJournalBatchBytes: positiveInteger(env, "maxJournalBatchBytes"),
    maxJournalBatchAgeMs: positiveInteger(env, "maxJournalBatchAgeMs"),
    journalCheckpointCommitInterval: positiveInteger(env, "journalCheckpointCommitInterval"),
    journalReclaimPagesPerPass: positiveInteger(env, "journalReclaimPagesPerPass"),
    maxOpenProjectorActivities: positiveInteger(env, "maxOpenProjectorActivities"),
    maxReceiveStreams: positiveInteger(env, "maxReceiveStreams"),
    maxReceiveReplayRows: positiveInteger(env, "maxReceiveReplayRows"),
    maxReceiveReplayBytes: positiveInteger(env, "maxReceiveReplayBytes"),
    maxSemanticFrameBytes: positiveInteger(env, "maxSemanticFrameBytes"),
    maxSemanticSegments: positiveInteger(env, "maxSemanticSegments"),
    maxSocketWriteMs: positiveInteger(env, "maxSocketWriteMs"),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, key: keyof RuntimeLimits): number {
  const variable = ENV_KEYS[key];
  const raw = env[variable];
  if (raw === undefined || raw.length === 0) return DEFAULT_RUNTIME_LIMITS[key];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${variable} must be a positive integer`);
  }
  return value;
}
