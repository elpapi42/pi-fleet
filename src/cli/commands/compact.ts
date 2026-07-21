import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { finishFinite } from "./common.js";

export async function runCompact(
  input: { readonly name: string; readonly human: boolean },
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  const result = await context.client.compact(
    { name: input.name },
    { signal: context.signal, operation: context.operationIds() },
  );
  return finishFinite(result, context, input.human);
}
