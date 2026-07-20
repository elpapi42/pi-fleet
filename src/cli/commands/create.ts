import { resolve } from "node:path";

import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { resolveMessageInput } from "../input.js";
import { finishFinite } from "./common.js";

export interface CreateCommandInput {
  readonly name: string;
  readonly instructions?: string;
  readonly cwd?: string;
  readonly human: boolean;
}

export async function runCreate(
  input: CreateCommandInput,
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  const instructions =
    input.instructions === undefined
      ? undefined
      : await resolveMessageInput(input.instructions, context.stdin);
  const result = await context.client.create(
    {
      name: input.name,
      ...(instructions === undefined ? {} : { instructions }),
      cwd: resolve(context.cwd, input.cwd ?? "."),
      piArgv: context.piArgv,
    },
    { signal: context.signal, operation: context.operationIds() },
  );
  return finishFinite(result, context, input.human);
}
