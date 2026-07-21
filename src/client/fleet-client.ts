import type { Readable, Writable } from "node:stream";

import type { Result } from "../shared/result.js";

export type AgentState = "restoring" | "working" | "idle" | "failed" | "destroying";
export type ProcessState = "resident" | "starting" | "absent" | "cleanup_uncertain";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly state: AgentState;
  readonly process: { readonly state: ProcessState };
  readonly session: { readonly path: string | null; readonly id: string | null };
  readonly error?: { readonly code: string } | undefined;
}

export interface CreateInput {
  readonly name: string;
  readonly instructions?: string;
  readonly cwd: string;
  readonly piArgv: readonly string[];
}

export interface SendInput {
  readonly name: string;
  readonly message: string;
}

export interface ReceiveInput {
  readonly name: string;
}

export interface StatusInput {
  readonly name: string;
}

export interface WatchInput {
  readonly name: string;
}

export interface DestroyInput {
  readonly name: string;
}

export interface CompactInput {
  readonly name: string;
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
  readonly code: string;
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

export interface ReceiveResult {
  readonly schemaVersion: 1;
  readonly type: "response";
  readonly agent: { readonly id: string; readonly name: string };
  readonly response: { readonly text: string; readonly observedAt: string };
}

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

export interface RawSessionChunk {
  readonly bytes: Uint8Array;
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
  ): Promise<Result<ReceiveResult, FleetClientError>>;
  status(
    input: StatusInput,
    options: RequestOptions,
  ): Promise<Result<StatusResult, FleetClientError>>;
  list(options: RequestOptions): Promise<Result<ListResult, FleetClientError>>;
  watchSession(
    input: WatchInput,
    options: RequestOptions,
  ): AsyncIterable<Result<RawSessionChunk, FleetClientError>>;
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
