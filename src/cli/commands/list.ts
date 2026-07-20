import type { CommandContext } from "../context.js";
import { finishFinite } from "./common.js";

export async function runList(
  input: { readonly human: boolean },
  context: CommandContext,
): Promise<number> {
  const result = await context.client.list({ signal: context.signal });
  return finishFinite(result, context, input.human);
}
