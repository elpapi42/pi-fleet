import type { CommandContext } from "../context.js";
import { finishSdkFinite } from "./common.js";

export async function runList(
  input: { readonly human: boolean },
  context: CommandContext,
): Promise<number> {
  return finishSdkFinite(
    context.client.list({ signal: context.signal }).then((agents) => ({
      schemaVersion: 1 as const,
      type: "agent.list" as const,
      agents,
    })),
    context,
    input.human,
  );
}
