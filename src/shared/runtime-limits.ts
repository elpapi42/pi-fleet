const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export interface RuntimeLimits {
  readonly maxResidentProcesses: number;
  readonly maxMessageBytes: number;
  readonly maxProtocolFrameBytes: number;
  readonly maxPiFrameBytes: number;
  readonly maxSessionRecordBytes: number;
  readonly maxWatchers: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxResidentProcesses: 32,
  maxMessageBytes: 512 * KIBIBYTE,
  maxProtocolFrameBytes: MEBIBYTE,
  maxPiFrameBytes: 8 * MEBIBYTE,
  maxSessionRecordBytes: 8 * MEBIBYTE,
  maxWatchers: 128,
});

const ENV_KEYS: Readonly<Record<keyof RuntimeLimits, string>> = {
  maxResidentProcesses: "PIFLEET_MAX_RESIDENT_PROCESSES",
  maxMessageBytes: "PIFLEET_MAX_MESSAGE_BYTES",
  maxProtocolFrameBytes: "PIFLEET_MAX_PROTOCOL_FRAME_BYTES",
  maxPiFrameBytes: "PIFLEET_MAX_PI_FRAME_BYTES",
  maxSessionRecordBytes: "PIFLEET_MAX_SESSION_RECORD_BYTES",
  maxWatchers: "PIFLEET_MAX_WATCHERS",
};

export function runtimeLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeLimits {
  return {
    maxResidentProcesses: positiveInteger(env, "maxResidentProcesses"),
    maxMessageBytes: positiveInteger(env, "maxMessageBytes"),
    maxProtocolFrameBytes: positiveInteger(env, "maxProtocolFrameBytes"),
    maxPiFrameBytes: positiveInteger(env, "maxPiFrameBytes"),
    maxSessionRecordBytes: positiveInteger(env, "maxSessionRecordBytes"),
    maxWatchers: positiveInteger(env, "maxWatchers"),
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
