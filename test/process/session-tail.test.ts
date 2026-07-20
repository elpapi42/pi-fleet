import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionTailSubscription } from "../../src/runtime/session-tail-subscription.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function nextWithTimeout(iterator: AsyncIterator<Buffer>): Promise<IteratorResult<Buffer>> {
  return Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("tail timed out")), 2_000),
    ),
  ]);
}

describe("raw Pi session tail", () => {
  it("starts an existing file at EOF and emits only later complete records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-tail-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    await writeFile(path, '{"type":"session"}\n');
    const abort = new AbortController();
    const iterator = new SessionTailSubscription(path, { signal: abort.signal, pollMs: 10 })[
      Symbol.asyncIterator
    ]();

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    await appendFile(path, '{"type":"message","text":"later"}\n');

    expect((await nextWithTimeout(iterator)).value?.toString()).toBe(
      '{"type":"message","text":"later"}\n',
    );
    abort.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  it("reads from byte zero when the file materializes after subscription", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-tail-"));
    roots.push(root);
    const path = join(root, "future.jsonl");
    const abort = new AbortController();
    const iterator = new SessionTailSubscription(path, { signal: abort.signal, pollMs: 10 })[
      Symbol.asyncIterator
    ]();

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    await writeFile(path, '{"type":"session"}\n{"type":"message"}\n');

    expect((await nextWithTimeout(iterator)).value?.toString()).toBe(
      '{"type":"session"}\n{"type":"message"}\n',
    );
    abort.abort();
  });

  it("fails instead of rebasing when the selected file is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-tail-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    const replacement = join(root, "replacement.jsonl");
    await writeFile(path, '{"type":"session"}\n');
    const iterator = new SessionTailSubscription(path, { pollMs: 10 })[Symbol.asyncIterator]();

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    await writeFile(replacement, '{"type":"replacement"}\n');
    await rename(replacement, path);

    await expect(nextWithTimeout(iterator)).rejects.toThrow(/replaced/i);
  });
});
