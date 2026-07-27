import type { Readable, Writable } from "node:stream";

import type { AgentSummary, PiFleetErrorCode, ReceiveCursor, SemanticEvent } from "./contracts.js";
import type { ReceiveStart } from "./agent-target.js";
import type { Result } from "../shared/result.js";

export type {
  AgentSummary,
  AgentState,
  PiFleetErrorCode as FleetClientErrorCode,
  ProcessState,
} from "./contracts.js";

export interface CreateInput {
  readonly name: string;
  readonly instructions?: string;
  readonly cwd: string;
  readonly piArgv: readonly string[];
}

export interface SendInput {
  readonly name: string;
  readonly expectedAgentId?: string;
  readonly message: string;
  readonly delivery?: "steer" | "followUp";
}

export interface ReceiveInput {
  readonly name: string;
  readonly expectedAgentId?: string;
  readonly start?: ReceiveStart;
  readonly untilIdle?: boolean;
}

export interface StatusInput {
  readonly name: string;
  readonly expectedAgentId?: string;
}

export interface DestroyInput {
  readonly name: string;
  readonly expectedAgentId?: string;
}

export interface CompactInput {
  readonly name: string;
  readonly expectedAgentId?: string;
}

export interface OperationIdentity {
  readonly operationId: string;
  readonly createdAt: string;
}

export interface RequestOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MutationOptions extends RequestOptions {
  readonly operation: OperationIdentity;
}

export interface FleetClientError {
  /** Codes are intentionally content-safe; payload-bearing details remain optional and redacted. */
  readonly code: PiFleetErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CreateResult {
  readonly schemaVersion: 1;
  readonly type: "agent.created";
  readonly agent: AgentSummary;
}

export interface SendResult {
  readonly schemaVersion: 1;
  readonly type: "message.accepted";
  readonly agent: { readonly id: string; readonly name: string };
  readonly acceptedAt: string;
}

export type ReceiveStreamItem =
  | { readonly type: "ready"; readonly cursor: ReceiveCursor }
  | { readonly type: "event"; readonly cursor: ReceiveCursor; readonly event: SemanticEvent };

export interface StatusResult {
  readonly schemaVersion: 1;
  readonly type: "agent.status";
  readonly agent: AgentSummary;
}

export interface ListResult {
  readonly schemaVersion: 1;
  readonly type: "agent.list";
  readonly agents: readonly AgentSummary[];
}

export interface DestroyResult {
  readonly schemaVersion: 1;
  readonly type: "agent.destroyed";
  readonly agent: { readonly id: string; readonly name: string };
}

export interface CompactResult {
  readonly schemaVersion: 1;
  readonly type: "agent.compacted";
  readonly agent: { readonly id: string; readonly name: string };
  readonly compaction: {
    readonly tokensBefore: number;
    readonly estimatedTokensAfter?: number;
  };
}

export interface FleetClient {
  create(
    input: CreateInput,
    options: MutationOptions,
  ): Promise<Result<CreateResult, FleetClientError>>;
  send(input: SendInput, options: MutationOptions): Promise<Result<SendResult, FleetClientError>>;
  receive(
    input: ReceiveInput,
    options: RequestOptions,
  ): AsyncIterable<Result<ReceiveStreamItem, FleetClientError>>;
  status(
    input: StatusInput,
    options: RequestOptions,
  ): Promise<Result<StatusResult, FleetClientError>>;
  list(options: RequestOptions): Promise<Result<ListResult, FleetClientError>>;
  destroy(
    input: DestroyInput,
    options: MutationOptions,
  ): Promise<Result<DestroyResult, FleetClientError>>;
  compact(
    input: CompactInput,
    options: MutationOptions,
  ): Promise<Result<CompactResult, FleetClientError>>;
}

export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}
