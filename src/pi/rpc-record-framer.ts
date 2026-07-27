export class RpcPartialRecordLimitError extends Error {
  constructor(
    readonly pendingBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Pi RPC unterminated record exceeded ${String(limitBytes)} bytes`);
    this.name = "RpcPartialRecordLimitError";
  }
}

/** Frames exact LF-terminated records without decoding or normalizing their bytes. */
export class RpcRecordFramer {
  readonly #segments: Buffer[] = [];
  #pendingBytes = 0;
  #failed = false;

  constructor(readonly maxPartialRecordBytes: number) {
    if (!Number.isSafeInteger(maxPartialRecordBytes) || maxPartialRecordBytes <= 0) {
      throw new Error("maxPartialRecordBytes must be a positive safe integer");
    }
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  push(chunk: Buffer): readonly Buffer[] {
    if (this.#failed) throw new Error("Pi RPC record framer has failed");
    if (chunk.length === 0) return [];

    const records: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.#appendPartial(chunk.subarray(offset));
        break;
      }

      const finalSegment = chunk.subarray(offset, newline + 1);
      if (this.#pendingBytes === 0) {
        records.push(Buffer.from(finalSegment));
      } else {
        this.#segments.push(finalSegment);
        this.#pendingBytes += finalSegment.length;
        records.push(Buffer.concat(this.#segments, this.#pendingBytes));
        this.#segments.length = 0;
        this.#pendingBytes = 0;
      }
      offset = newline + 1;
    }
    return records;
  }

  /** Returns, but never promotes, an interrupted trailing fragment. */
  finish(): Buffer | null {
    if (this.#pendingBytes === 0) return null;
    const trailing = Buffer.concat(this.#segments, this.#pendingBytes);
    this.#segments.length = 0;
    this.#pendingBytes = 0;
    return trailing;
  }

  #appendPartial(segment: Buffer): void {
    if (segment.length === 0) return;
    const nextBytes = this.#pendingBytes + segment.length;
    if (nextBytes > this.maxPartialRecordBytes) {
      this.#failed = true;
      throw new RpcPartialRecordLimitError(nextBytes, this.maxPartialRecordBytes);
    }
    this.#segments.push(Buffer.from(segment));
    this.#pendingBytes = nextBytes;
  }
}
