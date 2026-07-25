import { describe, expect, it } from "vitest";

import { RpcWatchHub } from "../../src/runtime/rpc-watch-hub.js";

async function nextWithin(
  iterator: AsyncIterator<Buffer>,
  timeoutMs = 1_000,
): Promise<IteratorResult<Buffer>> {
  let timer!: NodeJS.Timeout;
  return Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("watch did not advance")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("RPC watch hub", () => {
  it("forwards exact bytes from one Pi incarnation without interpreting them", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 2, maxQueuedBytes: 1024 });
    const abort = new AbortController();
    const iterator = hub.subscribe("reviewer", abort.signal)[Symbol.asyncIterator]();
    const publish = hub.beginIncarnation("reviewer", "incarnation-1");
    const bytes = Buffer.from([
      ...Buffer.from('{"type":"message_update","delta":"🙂"}\r\n'),
      0xff,
      0x00,
    ]);

    publish(bytes);

    expect((await nextWithin(iterator)).value).toEqual(bytes);
    abort.abort();
  });

  it("binds a watcher opened after an incarnation starts to that active incarnation", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 2, maxQueuedBytes: 1024 });
    const publish = hub.beginIncarnation("reviewer", "incarnation-1");
    const subscription = hub.subscribe("reviewer", new AbortController().signal);
    const iterator = subscription[Symbol.asyncIterator]();

    publish(Buffer.from("later"));
    expect((await nextWithin(iterator)).value?.toString()).toBe("later");

    hub.endIncarnation("reviewer", "incarnation-1");
    expect(await nextWithin(iterator)).toEqual({ done: true, value: undefined });
  });

  it("waits passively for the next incarnation and ends at that incarnation's exit", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 2, maxQueuedBytes: 1024 });
    const subscription = hub.subscribe("reviewer", new AbortController().signal);
    const iterator = subscription[Symbol.asyncIterator]();
    let advanced = false;
    const waiting = iterator.next().then((result) => {
      advanced = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(advanced).toBe(false);

    const publish = hub.beginIncarnation("reviewer", "incarnation-1");
    publish(Buffer.from("first"));
    expect((await waiting).value?.toString()).toBe("first");
    hub.endIncarnation("reviewer", "incarnation-1");
    expect(await nextWithin(iterator)).toEqual({ done: true, value: undefined });

    hub.beginIncarnation("reviewer", "incarnation-2")(Buffer.from("second"));
    expect(await nextWithin(iterator)).toEqual({ done: true, value: undefined });
  });

  it("removes an aborted watcher and enforces the watcher limit", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 1, maxQueuedBytes: 1024 });
    const abort = new AbortController();
    const first = hub.subscribe("reviewer", abort.signal)[Symbol.asyncIterator]();

    expect(() => hub.subscribe("reviewer", new AbortController().signal)).toThrow(
      expect.objectContaining({ code: "watcher_capacity_exceeded" }),
    );
    abort.abort();
    expect(await nextWithin(first)).toEqual({ done: true, value: undefined });
    expect(() => hub.subscribe("reviewer", new AbortController().signal)).not.toThrow();
  });

  it("retains watcher capacity until accepted bytes drain", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 1, maxQueuedBytes: 1024 });
    const subscription = hub.subscribe("reviewer", new AbortController().signal);
    const iterator = subscription[Symbol.asyncIterator]();
    const publish = hub.beginIncarnation("reviewer", "incarnation-1");
    publish(Buffer.from("accepted"));
    hub.endIncarnation("reviewer", "incarnation-1");

    expect(() => hub.subscribe("reviewer", new AbortController().signal)).toThrow(
      expect.objectContaining({ code: "watcher_capacity_exceeded" }),
    );
    expect((await iterator.next()).value?.toString()).toBe("accepted");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(() => hub.subscribe("reviewer", new AbortController().signal)).not.toThrow();
  });

  it("disconnects only a lagging watcher when its bounded queue overflows", async () => {
    const hub = new RpcWatchHub({ maxWatchers: 2, maxQueuedBytes: 5 });
    const slow = hub.subscribe("reviewer", new AbortController().signal)[Symbol.asyncIterator]();
    const healthy = hub.subscribe("reviewer", new AbortController().signal)[Symbol.asyncIterator]();
    const publish = hub.beginIncarnation("reviewer", "incarnation-1");

    publish(Buffer.from("1234"));
    expect((await nextWithin(healthy)).value?.toString()).toBe("1234");
    publish(Buffer.from("5678"));
    expect((await nextWithin(healthy)).value?.toString()).toBe("5678");

    expect((await nextWithin(slow)).value?.toString()).toBe("1234");
    await expect(nextWithin(slow)).rejects.toEqual(
      expect.objectContaining({ code: "watcher_lagged" }),
    );
  });
});
