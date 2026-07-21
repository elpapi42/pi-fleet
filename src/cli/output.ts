import type { Writable } from "node:stream";

import type {
  CompactResult,
  CreateResult,
  DestroyResult,
  FleetClientError,
  ListResult,
  ReceiveResult,
  SendResult,
  StatusResult,
} from "../client/fleet-client.js";

type FiniteResult =
  | CreateResult
  | SendResult
  | ReceiveResult
  | StatusResult
  | ListResult
  | DestroyResult
  | CompactResult;

export function writeResult(stream: Writable, result: FiniteResult, human: boolean): void {
  stream.write(human ? `${renderHuman(result)}\n` : `${JSON.stringify(result)}\n`);
}

export function writeError(stream: Writable, error: FleetClientError, human: boolean): void {
  if (human) {
    stream.write(`${error.message}\n`);
    return;
  }
  stream.write(`${JSON.stringify({ schemaVersion: 1, type: "error", error })}\n`);
}

function renderHuman(result: FiniteResult): string {
  switch (result.type) {
    case "agent.created":
      return `${result.agent.name}: ${result.agent.state} (${result.agent.process.state})`;
    case "message.accepted":
      return `${result.agent.name}: message accepted`;
    case "response":
      return result.response.text;
    case "agent.status":
      return `${result.agent.name}: ${result.agent.state} (${result.agent.process.state})`;
    case "agent.list":
      return result.agents.length === 0
        ? "No agents"
        : result.agents
            .map((agent) => `${agent.name}\t${agent.state}\t${agent.process.state}`)
            .join("\n");
    case "agent.destroyed":
      return `${result.agent.name}: destroyed`;
    case "agent.compacted":
      return `${result.agent.name}: compacted (${String(result.compaction.tokensBefore)} → ${String(result.compaction.estimatedTokensAfter ?? "unknown")} estimated tokens)`;
  }
}
