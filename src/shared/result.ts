export type Result<Value, Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error };

export function ok<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

export function err<Error>(error: Error): Result<never, Error> {
  return { ok: false, error };
}
