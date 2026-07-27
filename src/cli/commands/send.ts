import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { resolveMessageInput } from "../input.js";
import { finishSdkFinite } from "./common.js";

export interface SendCommandInput {
  readonly name: string;
  readonly message: string;
  readonly delivery: "steer" | "followUp";
  readonly human: boolean;
}

export async function runSend(input: SendCommandInput, context: CommandContext): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  const message = await resolveMessageInput(input.message, context.stdin);
  return finishSdkFinite(
    (async () => {
      const agent = await context.client.get(input.name, { signal: context.signal });
      const receipt = await agent.send(message, {
        delivery: input.delivery,
        signal: context.signal,
      });
      return {
        schemaVersion: 1 as const,
        type: "message.accepted" as const,
        agent: { id: agent.id, name: agent.name },
        acceptedAt: receipt.acceptedAt,
      };
    })(),
    context,
    input.human,
  );
}
