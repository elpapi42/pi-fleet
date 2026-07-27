import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { finishSdkFinite } from "./common.js";

export async function runCompact(
  input: { readonly name: string; readonly human: boolean },
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  return finishSdkFinite(
    (async () => {
      const agent = await context.client.get(input.name, { signal: context.signal });
      const compaction = await agent.compact({ signal: context.signal });
      return {
        schemaVersion: 1 as const,
        type: "agent.compacted" as const,
        agent: { id: agent.id, name: agent.name },
        compaction,
      };
    })(),
    context,
    input.human,
  );
}
