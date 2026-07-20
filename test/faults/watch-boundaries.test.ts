import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionTailSubscription } from "../../src/runtime/session-tail-subscription.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function nextWithin(iterator: AsyncIterator<Buffer>): Promise<IteratorResult<Buffer>> {
  let timer!: NodeJS.Timeout;
  return Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("watch did not produce data")), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function tail(initial: Buffer | string) {
  const root = await mkdtemp(join(tmpdir(), "pifleet-watch-boundary-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, initial);
  const abort = new AbortController();
  const iterator = new SessionTailSubscription(path, {
    signal: abort.signal,
    pollMs: 5,
    readChunkBytes: 3,
  })[Symbol.asyncIterator]();
  return { path, abort, iterator };
}

describe("raw watch record boundaries", () => {
  it("retains an existing partial prefix and emits the full record only after LF arrives", async () => {
    const record = '{"type":"message","text":"later"}';
    const { path, abort, iterator } = await tail(record.slice(0, 15));
    await appendFile(path, `${record.slice(15)}\n`);

    expect((await nextWithin(iterator)).value?.toString()).toBe(`${record}\n`);
    abort.abort();
  });

  it("preserves multiple complete records from one append", async () => {
    const { path, abort, iterator } = await tail('{"type":"session"}\n');
    const appended = '{"type":"thinking"}\n{"type":"text"}\n';
    await appendFile(path, appended);

    let received = "";
    while (received.split("\n").length - 1 < 2) {
      received += (await nextWithin(iterator)).value?.toString() ?? "";
    }
    expect(received).toBe(appended);
    abort.abort();
  });

  it("preserves multibyte UTF-8 when reads split inside a code point", async () => {
    const { path, abort, iterator } = await tail('{"type":"session"}\n');
    const appended = `${JSON.stringify({ type: "message", text: "🙂 café 日本語" })}\n`;
    await appendFile(path, Buffer.from(appended));

    expect((await nextWithin(iterator)).value).toEqual(Buffer.from(appended));
    abort.abort();
  });

  it("forwards a complete externally appended line without interpreting Pi semantics", async () => {
    const { path, abort, iterator } = await tail('{"type":"session"}\n');
    await appendFile(path, "not-json-but-complete\n");

    expect((await nextWithin(iterator)).value?.toString()).toBe("not-json-but-complete\n");
    abort.abort();
  });
});
