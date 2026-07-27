import type { AgentId, ReceiveCursor } from "./contracts.js";

/** A user-facing lookup that may resolve to the current generation for a name. */
export interface AgentNameLookup {
  readonly name: string;
}

/** A resolved target that must not retarget a later same-name agent. */
export interface ExpectedAgentTarget extends AgentNameLookup {
  readonly expectedAgentId: AgentId;
}

export type ReceiveStart =
  | { readonly kind: "live" }
  | { readonly kind: "after"; readonly cursor: ReceiveCursor }
  | { readonly kind: "start" };

/** The future cursor encoding contract; encoded cursor contents remain private. */
export interface ReceiveCursorCodec {
  readonly version: 1;
  encode(boundary: {
    readonly agentId: AgentId;
    readonly epoch: number;
    readonly position: number;
    readonly kind?: "position" | "continuation";
  }): ReceiveCursor;
  decode(cursor: ReceiveCursor): {
    readonly agentId: AgentId;
    readonly epoch: number;
    readonly position: number;
    readonly kind: "position" | "continuation";
  };
}
