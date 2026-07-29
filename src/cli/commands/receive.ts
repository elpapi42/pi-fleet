import { once } from "node:events";

import { PiFleetError, receiveAgentUntilIdle } from "../../client/sdk-facade.js";
import type { ReceiveCursor, SemanticEvent } from "../../client/contracts.js";
import { isAgentName } from "../../shared/identifiers.js";
import type { CommandContext } from "../context.js";
import { writeError } from "../output.js";

export interface ReceiveCommandInput {
  readonly name: string;
  readonly after?: string;
  readonly fromStart: boolean;
  readonly untilIdle: boolean;
  readonly human: boolean;
}

export async function runReceive(
  input: ReceiveCommandInput,
  context: CommandContext,
): Promise<number> {
  if (!isAgentName(input.name)) throw new Error("invalid agent name");
  if (input.after !== undefined && input.fromStart) {
    throw new Error("--after and --from-start cannot be combined");
  }
  if (input.untilIdle && (input.after !== undefined || input.fromStart)) {
    throw new Error("--until-idle uses a live boundary and cannot be combined with history");
  }
  try {
    const agent = await context.client.get(input.name, { signal: context.signal });
    const stream = input.untilIdle
      ? await receiveAgentUntilIdle(agent, { signal: context.signal })
      : await agent.receive(
          input.after !== undefined
            ? { after: input.after as ReceiveCursor, signal: context.signal }
            : input.fromStart
              ? { fromStart: true, signal: context.signal }
              : { signal: context.signal },
        );
    context.stderr.write(
      input.human
        ? `receive ready at ${stream.cursor}\n`
        : `${JSON.stringify({ schemaVersion: 1, type: "receive.ready", cursor: stream.cursor })}\n`,
    );
    for await (const event of stream) {
      const output = input.human ? `${renderHumanEvent(event)}\n` : `${JSON.stringify(event)}\n`;
      try {
        if (!context.stdout.write(output)) await once(context.stdout, "drain");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPIPE") return 0;
        throw error;
      }
    }
    return 0;
  } catch (error: unknown) {
    const publicError = PiFleetError.from(error);
    writeError(
      context.stderr,
      {
        code: publicError.code,
        message: publicError.message,
        ...(publicError.details === undefined ? {} : { details: publicError.details }),
      },
      input.human,
    );
    return publicError.code === "timeout" ? 124 : 1;
  }
}

/** Renders one lifecycle event as a readable line without inventing activity. */
function renderHumanEvent(event: SemanticEvent): string {
  const at = event.observedAt;
  switch (event.type) {
    case "assistant.thinking.started":
      return `${at} thinking…`;
    case "assistant.thinking.finished":
      return `${at} thinking: ${collapse(event.text)}`;
    case "assistant.message.started":
      return `${at} message…`;
    case "assistant.message.finished":
      return `${at} message: ${collapse(event.text)}`;
    case "tool.execution.started":
      return `${at} tool ${event.tool.name} started: ${collapse(inspectValue(event.tool.input))}`;
    case "tool.execution.finished":
      return `${at} tool ${event.tool.name} ${event.tool.isError ? "failed" : "finished"}: ${collapse(
        inspectValue(event.tool.output),
      )}`;
  }
}

function inspectValue(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Keeps one event on one line so a human tail stays scannable. */
function collapse(text: string, limit = 400): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
