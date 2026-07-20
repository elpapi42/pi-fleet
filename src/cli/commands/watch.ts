import { once } from "node:events";

import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { writeError } from "../output.js";

export async function runWatch(name: string, context: CommandContext): Promise<number> {
  if (!isAgentName(name)) throw new Error("invalid agent name");
  for await (const result of context.client.watchSession({ name }, { signal: context.signal })) {
    if (!result.ok) {
      writeError(context.stderr, result.error, false);
      return 1;
    }
    if (!context.stdout.write(result.value.bytes)) await once(context.stdout, "drain");
  }
  return 0;
}
