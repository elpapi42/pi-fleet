import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { finishSdkFinite } from "./common.js";

export async function runDestroy(
  input: { readonly name: string; readonly human: boolean },
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  return finishSdkFinite(
    (async () => {
      const agent = await context.client.get(input.name, { signal: context.signal });
      await agent.destroy({ signal: context.signal });
      return {
        schemaVersion: 1 as const,
        type: "agent.destroyed" as const,
        agent: { id: agent.id, name: agent.name },
      };
    })(),
    context,
    input.human,
  );
}
