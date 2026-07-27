import type { ActivityId, AgentId, ContinuityEpoch, ReceiveCursor } from "../client/contracts.js";

export type {
  ActivityId,
  AgentEventId,
  AgentId,
  AssistantMessageFinishedEvent,
  AssistantMessageStartedEvent,
  AssistantThinkingFinishedEvent,
  AssistantThinkingStartedEvent,
  ContinuityEpoch,
  ReceiveCursor,
  SemanticEvent,
  SemanticEventBase,
  ToolExecutionFinishedEvent,
  ToolExecutionStartedEvent,
} from "../client/contracts.js";

export type IncarnationId = string & { readonly __brand: "IncarnationId" };

export interface RawRpcRecord {
  readonly agentId: AgentId;
  readonly incarnationId: IncarnationId;
  readonly position: number;
  readonly observedAt: string;
  /** Exact complete stdout bytes, including the terminating LF. */
  readonly bytes: Buffer;
}

export interface ReceiveBoundary {
  readonly agentId: AgentId;
  readonly epoch: ContinuityEpoch;
  readonly cursor: ReceiveCursor;
}

export interface ProjectorState {
  readonly version: 1;
  /** Monotonic assistant-envelope generation used to isolate repeated content indexes. */
  readonly messageSequence: number;
  /** Completed indexes in the current envelope, retained only until message_end. */
  readonly finishedThinkingIndexes: readonly number[];
  readonly openActivities: readonly ProjectorActivity[];
}

export type ProjectorActivity =
  | {
      readonly kind: "thinking";
      readonly activityId: ActivityId;
      readonly messageSequence: number;
      readonly contentIndex: number;
      readonly text: string;
    }
  | {
      readonly kind: "message";
      readonly activityId: ActivityId;
      readonly messageSequence: number;
    }
  | {
      readonly kind: "tool";
      readonly activityId: ActivityId;
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    };
