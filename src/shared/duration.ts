import { err, ok, type Result } from "./result.js";

type DurationParseError = "invalid_duration";

const UNIT_TO_MILLISECONDS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

export function parseDuration(input: string): Result<number, DurationParseError> {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input);

  if (match === null) {
    return err("invalid_duration");
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";

  return ok(amount * UNIT_TO_MILLISECONDS[unit as keyof typeof UNIT_TO_MILLISECONDS]);
}
