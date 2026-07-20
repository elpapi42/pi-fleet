import { Value } from "@sinclair/typebox/value";

import { RequestSchema, type ProtocolRequest } from "./envelope.js";

export function parseProtocolRequest(value: unknown): ProtocolRequest {
  if (!Value.Check(RequestSchema, value)) {
    const first = Value.Errors(RequestSchema, value).First();
    throw new Error(
      first === undefined ? "Invalid protocol request" : `Invalid protocol request: ${first.path}`,
    );
  }
  return value;
}
