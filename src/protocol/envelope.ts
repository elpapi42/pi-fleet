import { Type, type Static } from "@sinclair/typebox";

import { PiRuntimeIdentitySchema } from "./pi-identity.js";
import type { SemanticSegmentFrame } from "./semantic-segmentation.js";
import { PROTOCOL_VERSION } from "./version.js";

export const OperationSchema = Type.Object(
  { operationId: Type.String({ minLength: 1 }), createdAt: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RequestSchema = Type.Object(
  {
    v: Type.Literal(PROTOCOL_VERSION),
    requestId: Type.String({ minLength: 1 }),
    method: Type.Union([
      Type.Literal("agent.create"),
      Type.Literal("agent.send"),
      Type.Literal("agent.receive"),
      Type.Literal("agent.status"),
      Type.Literal("agent.list"),
      Type.Literal("agent.destroy"),
      Type.Literal("agent.compact"),
    ]),
    params: Type.Record(Type.String(), Type.Unknown()),
    operation: Type.Optional(OperationSchema),
    runtime: Type.Optional(
      Type.Object({ pi: PiRuntimeIdentitySchema }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

export type ProtocolRequest = Static<typeof RequestSchema>;

export interface ProtocolSuccess {
  readonly v: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface ProtocolFailure {
  readonly v: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export type ProtocolResponse = ProtocolSuccess | ProtocolFailure;

export type ProtocolStreamFrame =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly stream: "ready";
      readonly cursor: string;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly stream: "semantic.segment";
      readonly segment: SemanticSegmentFrame;
    }
  | { readonly v: typeof PROTOCOL_VERSION; readonly requestId: string; readonly stream: "end" }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly stream: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: Record<string, unknown>;
      };
    };
