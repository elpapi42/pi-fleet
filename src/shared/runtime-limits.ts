const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export interface RuntimeLimits {
  readonly maxResidentProcesses: number;
  readonly maxMessageBytes: number;
  readonly maxProtocolFrameBytes: number;
  readonly maxPiFrameBytes: number;
  readonly maxWatchers: number;
  readonly maxWatchQueuedBytes: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxResidentProcesses: 32,
  maxMessageBytes: 512 * KIBIBYTE,
  maxProtocolFrameBytes: MEBIBYTE,
  maxPiFrameBytes: 8 * MEBIBYTE,
  maxWatchers: 128,
  maxWatchQueuedBytes: MEBIBYTE,
});

const ENV_KEYS: Readonly<Record<keyof RuntimeLimits, string>> = {
  maxResidentProcesses: "PIFLEET_MAX_RESIDENT_PROCESSES",
  maxMessageBytes: "PIFLEET_MAX_MESSAGE_BYTES",
  maxProtocolFrameBytes: "PIFLEET_MAX_PROTOCOL_FRAME_BYTES",
  maxPiFrameBytes: "PIFLEET_MAX_PI_FRAME_BYTES",
  maxWatchers: "PIFLEET_MAX_WATCHERS",
  maxWatchQueuedBytes: "PIFLEET_MAX_WATCH_QUEUED_BYTES",
};

export function runtimeLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return {
    maxResidentProcesses: positiveInteger(env, "maxResidentProcesses"),
    maxMessageBytes: positiveInteger(env, "maxMessageBytes"),
    maxProtocolFrameBytes: positiveInteger(env, "maxProtocolFrameBytes"),
    maxPiFrameBytes: positiveInteger(env, "maxPiFrameBytes"),
    maxWatchers: positiveInteger(env, "maxWatchers"),
    maxWatchQueuedBytes: positiveInteger(env, "maxWatchQueuedBytes"),
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
