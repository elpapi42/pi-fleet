export interface JournalWorkerRequest {
  readonly id: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface JournalWorkerResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export function isJournalWorkerResponse(value: unknown): value is JournalWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<JournalWorkerResponse>;
  return (
    typeof response.id === "string" &&
    typeof response.ok === "boolean" &&
    (response.error === undefined || typeof response.error === "string")
  );
}
