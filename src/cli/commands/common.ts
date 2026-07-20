import type { FleetClientError } from "../../client/fleet-client.js";
import type { Result } from "../../shared/result.js";
import type { CommandContext } from "../context.js";
import { writeError, writeResult } from "../output.js";

export function finishFinite<T extends Parameters<typeof writeResult>[1]>(
  result: Result<T, FleetClientError>,
  context: CommandContext,
  human: boolean,
): number {
  if (result.ok) {
    writeResult(context.stdout, result.value, human);
    return 0;
  }
  writeError(context.stderr, result.error, human);
  return result.error.code === "timeout" ? 124 : 1;
}

export function invalidArguments(message: string): FleetClientError {
  return { code: "invalid_arguments", message };
}
