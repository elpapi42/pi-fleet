import { PiFleetError } from "../../client/sdk-facade.js";
import type { CommandContext } from "../context.js";
import { writeError, writeResult, type FiniteResult } from "../output.js";

export async function finishSdkFinite(
  operation: Promise<FiniteResult>,
  context: CommandContext,
  human: boolean,
): Promise<number> {
  try {
    writeResult(context.stdout, await operation, human);
    return 0;
  } catch (error: unknown) {
    const publicError = PiFleetError.from(error);
    writeError(
      context.stderr,
      {
        code: publicError.code,
        message: publicError.message,
        ...(publicError.details === undefined ? {} : { details: publicError.details }),
      },
      human,
    );
    return publicError.code === "timeout" ? 124 : 1;
  }
}
