import type { Readable } from "node:stream";

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

export async function resolveMessageInput(
  value: string,
  stdin: Readable,
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
): Promise<string> {
  if (value !== "-") return requireContent(value);

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`stdin exceeds the ${maxBytes}-byte limit`);
    chunks.push(buffer);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("stdin must be valid UTF-8");
  }
  return requireContent(decoded);
}

function requireContent(value: string): string {
  if (value.trim().length === 0) throw new Error("message must not be empty or whitespace-only");
  return value;
}
