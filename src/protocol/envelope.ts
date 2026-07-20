import { Type, type Static } from "@sinclair/typebox";

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
      Type.Literal("agent.watch"),
      Type.Literal("agent.destroy"),
    ]),
    params: Type.Record(Type.String(), Type.Unknown()),
    operation: Type.Optional(OperationSchema),
  },
  { additionalProperties: false },
);

export type ProtocolRequest = Static<typeof RequestSchema>;

export interface ProtocolSuccess {
  readonly v: 1;
  readonly requestId: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface ProtocolFailure {
  readonly v: 1;
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
  | { readonly v: 1; readonly requestId: string; readonly stream: "ready" }
  | { readonly v: 1; readonly requestId: string; readonly stream: "chunk"; readonly data: string }
  | { readonly v: 1; readonly requestId: string; readonly stream: "end" }
  | {
      readonly v: 1;
      readonly requestId: string;
      readonly stream: "error";
      readonly error: { readonly code: string; readonly message: string };
    };
