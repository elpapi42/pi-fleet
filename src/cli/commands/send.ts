import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { resolveMessageInput } from "../input.js";
import { finishFinite } from "./common.js";

export interface SendCommandInput {
  readonly name: string;
  readonly message: string;
  readonly human: boolean;
}

export async function runSend(input: SendCommandInput, context: CommandContext): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  const message = await resolveMessageInput(input.message, context.stdin);
  const result = await context.client.send(
    { name: input.name, message },
    { signal: context.signal, operation: context.operationIds() },
  );
  return finishFinite(result, context, input.human);
}
