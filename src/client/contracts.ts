export type AgentId = string & { readonly __brand: "AgentId" };
export type AgentEventId = string & { readonly __brand: "AgentEventId" };
export type ActivityId = string & { readonly __brand: "ActivityId" };
export type ReceiveCursor = string & { readonly __brand: "ReceiveCursor" };
export type ContinuityEpoch = number & { readonly __brand: "ContinuityEpoch" };

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

export const PI_FLEET_ERROR_CODES = [
  "agent_busy",
  "agent_destroyed",
  "agent_destroying",
  "agent_not_found",
  "capacity_exceeded",
  "cancelled",
  "compaction_failed",
  "compaction_uncertain",
  "cursor_expired",
  "cursor_invalid",
  "cursor_wrong_agent",
  "delivery_uncertain",
  "destroy_incomplete",
  "incarnation_cleanup_uncertain",
  "internal_error",
  "invalid_arguments",
  "invalid_request",
  "name_taken",
  "nothing_to_compact",
  "observation_uncertain",
  "operation_conflict",
  "operation_in_progress",
  "pi_installation_changed",
  "pi_not_executable",
  "pi_not_found",
  "pi_runtime_mismatch",
  "pi_service_mismatch",
  "pi_start_failed",
  "pi_version_unavailable",
  "pi_version_unsupported",
  "protocol_error",
  "protocol_incompatible",
  "receive_resource_exhausted",
  "runtime_interrupted",
  "runtime_unavailable",
  "runtime_upgrade_deferred",
  "semantic_event_too_large",
  "stale_agent",
  "state_corrupt",
  "storage_unavailable",
  "timeout",
] as const;

export type PiFleetErrorCode = (typeof PI_FLEET_ERROR_CODES)[number];

const piFleetErrorCodeSet = new Set<string>(PI_FLEET_ERROR_CODES);

export function isPiFleetErrorCode(value: unknown): value is PiFleetErrorCode {
  return typeof value === "string" && piFleetErrorCodeSet.has(value);
}

export interface SemanticEventBase {
  readonly id: AgentEventId;
  readonly activityId: ActivityId;
  readonly agentId: AgentId;
  readonly cursor: ReceiveCursor;
  readonly epoch: ContinuityEpoch;
  readonly sourceRawPosition: number;
  readonly observedAt: string;
}

export interface AssistantThinkingStartedEvent extends SemanticEventBase {
  readonly type: "assistant.thinking.started";
}

export interface AssistantThinkingFinishedEvent extends SemanticEventBase {
  readonly type: "assistant.thinking.finished";
  readonly text: string;
}

export interface AssistantMessageStartedEvent extends SemanticEventBase {
  readonly type: "assistant.message.started";
}

export interface AssistantMessageFinishedEvent extends SemanticEventBase {
  readonly type: "assistant.message.finished";
  readonly text: string;
}

export interface ToolExecutionStartedEvent extends SemanticEventBase {
  readonly type: "tool.execution.started";
  readonly tool: {
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
  };
}

export interface ToolExecutionFinishedEvent extends SemanticEventBase {
  readonly type: "tool.execution.finished";
  readonly tool: {
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly isError: boolean;
  };
}

export type SemanticEvent =
  | AssistantThinkingStartedEvent
  | AssistantThinkingFinishedEvent
  | AssistantMessageStartedEvent
  | AssistantMessageFinishedEvent
  | ToolExecutionStartedEvent
  | ToolExecutionFinishedEvent;

export interface ReceiveStream extends AsyncIterable<SemanticEvent> {
  /** Cursor for the registered replay/live boundary, available before the first event. */
  readonly cursor: ReceiveCursor;
}
