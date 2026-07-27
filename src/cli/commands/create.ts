import { resolve } from "node:path";

import { agentInitialStatus } from "../../client/sdk-facade.js";
import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { resolveMessageInput } from "../input.js";
import { finishSdkFinite } from "./common.js";

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
  return finishSdkFinite(
    (async () => {
      const agent = await context.client.create(
        {
          name: input.name,
          ...(instructions === undefined ? {} : { instructions }),
          cwd: resolve(context.cwd, input.cwd ?? "."),
          piArgs: context.piArgv,
        },
        { signal: context.signal },
      );
      return {
        schemaVersion: 1 as const,
        type: "agent.created" as const,
        agent: agentInitialStatus(agent),
      };
    })(),
    context,
    input.human,
  );
}
