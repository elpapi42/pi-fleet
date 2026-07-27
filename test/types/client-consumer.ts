import {
  PiFleetError,
  connectPiFleet,
  type Agent,
  type ReceiveCursor,
  type SemanticEvent,
} from "@elpapi42/pi-fleet/client";

export async function consume(agent: Agent, cursor?: ReceiveCursor): Promise<void> {
  const stream = await agent.receive(cursor === undefined ? {} : { after: cursor });
  const initial: ReceiveCursor = stream.cursor;
  void initial;
  for await (const event of stream) render(event);
}

export async function connectOnly(): Promise<void> {
  const client = await connectPiFleet({ autoStartRuntime: false });
  try {
    const summaries = await client.list();
    if (summaries[0] !== undefined) await client.get(summaries[0].name);
  } catch (error: unknown) {
    if (error instanceof PiFleetError) void error.code;
  } finally {
    await client.close();
  }
}

function render(event: SemanticEvent): string {
  switch (event.type) {
    case "assistant.thinking.started":
    case "assistant.message.started":
      return event.type;
    case "assistant.thinking.finished":
    case "assistant.message.finished":
      return event.text;
    case "tool.execution.started":
      return event.tool.name;
    case "tool.execution.finished":
      return String(event.tool.output);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
