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

/** Renders one lifecycle event as a readable, pairable tail line. */
function renderHumanEvent(event: SemanticEvent): string {
  const at = event.observedAt;
  const activity = activityRef(event.activityId);
  switch (event.type) {
    case "assistant.thinking.started":
      return `${at} start thinking ${activity}`;
    case "assistant.thinking.finished":
      return `${at} end   thinking ${activity} ${collapse(event.text, 400)}`;
    case "assistant.message.started":
      return `${at} start message ${activity}`;
    case "assistant.message.finished":
      return `${at} end   message ${activity} ${collapse(event.text, 400)}`;
    case "tool.execution.started":
      return `${at} start tool ${event.tool.name} ${activity} input=${displayValue(event.tool.input, 160)}`;
    case "tool.execution.finished":
      return `${at} end   tool ${event.tool.name} ${activity} ${event.tool.isError ? "error" : "ok"} input=${displayValue(event.tool.input, 160)} output=${displayValue(event.tool.output, 160)}`;
  }
}

/** A compact stable suffix preserves pair correlation without printing opaque UUIDs in full. */
function activityRef(activityId: string): string {
  return `#${activityId.slice(-6)}`;
}

function displayValue(value: unknown, limit: number): string {
  const rendered =
    value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value);
  return collapse(rendered ?? "undefined", limit);
}

/** Keeps one event on one line so a human tail stays scannable. */
function collapse(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
