import { open, stat } from "node:fs/promises";

interface TailOptions {
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly maxRecordBytes?: number;
  readonly readChunkBytes?: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface TailState {
  readonly identity: FileIdentity | null;
  readonly appeared: boolean;
  readonly offset: number;
  readonly partial: Buffer;
}

export class SessionTailSubscription implements AsyncIterable<Buffer> {
  readonly #initialState: Promise<TailState>;
  readonly #pollMs: number;
  readonly #maxRecordBytes: number;
  readonly #readChunkBytes: number;
  readonly #signal: AbortSignal | undefined;

  constructor(
    private readonly sessionPath: string,
    options: TailOptions = {},
  ) {
    this.#pollMs = options.pollMs ?? 50;
    this.#maxRecordBytes = options.maxRecordBytes ?? 1024 * 1024;
    this.#readChunkBytes = options.readChunkBytes ?? 64 * 1024;
    this.#signal = options.signal;
    this.#initialState = this.#establishBaseline();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    let state = await this.#initialState;
    while (this.#signal?.aborted !== true) {
      const current = await stat(this.sessionPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });

      if (current === null) {
        if (state.appeared) throw new Error("Selected Pi session file disappeared or was replaced");
        await delay(this.#pollMs, this.#signal);
        continue;
      }
      if (!current.isFile()) throw new Error("Selected Pi session path is not a regular file");

      const identity = { dev: current.dev, ino: current.ino };
      if (state.identity !== null && !sameIdentity(state.identity, identity)) {
        throw new Error("Selected Pi session file was replaced");
      }
      if (current.size < state.offset) throw new Error("Selected Pi session file was truncated");

      if (!state.appeared) {
        state = { identity, appeared: true, offset: 0, partial: Buffer.alloc(0) };
      }
      if (current.size === state.offset) {
        await delay(this.#pollMs, this.#signal);
        continue;
      }

      let offset = state.offset;
      let partial = state.partial;
      const targetSize = current.size;
      while (offset < targetSize) {
        const length = Math.min(this.#readChunkBytes, targetSize - offset);
        const chunk = await readRange(this.sessionPath, offset, length);
        if (chunk.length === 0) break;
        offset += chunk.length;
        const combined = Buffer.concat([partial, chunk]);
        const completeRecords: Buffer[] = [];
        let recordStart = 0;
        while (true) {
          const newline = combined.indexOf(0x0a, recordStart);
          if (newline < 0) break;
          const record = combined.subarray(recordStart, newline + 1);
          if (record.length > this.#maxRecordBytes) {
            throw new Error("Pi session record exceeds the watch limit");
          }
          completeRecords.push(Buffer.from(record));
          recordStart = newline + 1;
        }
        partial = Buffer.from(combined.subarray(recordStart));
        if (partial.length > this.#maxRecordBytes) {
          throw new Error("Pi session record exceeds the watch limit");
        }
        if (completeRecords.length > 0) yield Buffer.concat(completeRecords);
      }
      state = { identity, appeared: true, offset, partial };
    }
  }

  async #establishBaseline(): Promise<TailState> {
    const current = await stat(this.sessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === null) {
      return { identity: null, appeared: false, offset: 0, partial: Buffer.alloc(0) };
    }
    if (!current.isFile()) throw new Error("Selected Pi session path is not a regular file");

    const readStart = Math.max(0, current.size - this.#maxRecordBytes - 1);
    const tail = await readRange(this.sessionPath, readStart, current.size - readStart);
    const lastNewline = tail.lastIndexOf(0x0a);
    const partial = lastNewline < 0 ? tail : tail.subarray(lastNewline + 1);
    if (partial.length > this.#maxRecordBytes || (readStart > 0 && lastNewline < 0)) {
      throw new Error("Existing Pi session record exceeds the watch limit");
    }
    return {
      identity: { dev: current.dev, ino: current.ino },
      appeared: true,
      offset: current.size,
      partial: Buffer.from(partial),
    };
  }
}

async function readRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, position + offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
