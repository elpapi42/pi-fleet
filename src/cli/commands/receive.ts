import { isAgentName } from "../../shared/identifiers.js";
import { parseDuration } from "../../shared/duration.js";
import type { CommandContext } from "../context.js";
import { finishFinite } from "./common.js";

export interface ReceiveCommandInput {
  readonly name: string;
  readonly timeout?: string;
  readonly human: boolean;
}

export async function runReceive(
  input: ReceiveCommandInput,
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  const parsedTimeout = input.timeout === undefined ? undefined : parseDuration(input.timeout);
  if (parsedTimeout !== undefined && !parsedTimeout.ok) throw new Error("invalid timeout duration");
  const timeoutMs = parsedTimeout?.ok === true ? parsedTimeout.value : undefined;
  const result = await context.client.receive(
    { name: input.name },
    { signal: context.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
  return finishFinite(result, context, input.human);
}
