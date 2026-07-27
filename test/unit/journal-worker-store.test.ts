import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { AgentId, ContinuityEpoch, IncarnationId } from "../../src/runtime/semantic-events.js";
import { WorkerJournalStore } from "../../src/store/worker-journal-store.js";

interface PostedRequest {
  readonly id: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

class FakeWorker extends EventEmitter {
  readonly posted: Array<{ request: PostedRequest; transfers: readonly ArrayBuffer[] }> = [];
  terminateCalls = 0;

  postMessage(request: PostedRequest, transfers: readonly ArrayBuffer[] = []): void {
    this.posted.push({ request, transfers });
    if (request.method === "close") {
      queueMicrotask(() => this.emit("message", { id: request.id, ok: true }));
    }
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    this.emit("exit", 0);
    return 0;
  }

  reply(index: number, value: unknown): void {
    const posted = this.posted[index];
    if (posted === undefined) throw new Error("Missing worker request");
    this.emit("message", { id: posted.request.id, ok: true, value });
  }
}

const agentId = "agent-1" as AgentId;

describe("dormant WorkerJournalStore", () => {
  it("bounds pending work and gives durability writes priority over replay reads", async () => {
    const worker = new FakeWorker();
    const store = new WorkerJournalStore("unused.sqlite", {
      worker,
      maxPending: 3,
    });

    const firstRead = store.readEventsForReader("reader-1", {
      agentId,
      epoch: 1 as ContinuityEpoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    });
    const write = store.putEpoch({
      agentId,
      epoch: 1 as ContinuityEpoch,
      state: "open",
      lastSafeEventPosition: 0,
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    const secondRead = store.getDiagnostics();
    await expect(store.getAgentById(agentId)).rejects.toThrow(/capacity/i);

    expect(worker.posted.map(({ request }) => request.method)).toEqual(["readEvents"]);
    worker.reply(0, []);
    await firstRead;
    expect(worker.posted.map(({ request }) => request.method)).toEqual(["readEvents", "putEpoch"]);
    worker.reply(1, undefined);
    await write;
    expect(worker.posted.map(({ request }) => request.method)).toEqual([
      "readEvents",
      "putEpoch",
      "getDiagnostics",
    ]);
    worker.reply(2, {
      rawRecordCount: 0,
      rawBytes: 0,
      semanticEventCount: 0,
      agentCount: 0,
    });
    await secondRead;
    await store.close();
  });

  it("runs maintenance ahead of queued replay diagnostics", async () => {
    const worker = new FakeWorker();
    const store = new WorkerJournalStore("unused.sqlite", { worker, maxPending: 3 });
    const replay = store.readEventsForReader("reader-1", {
      agentId,
      epoch: 1 as ContinuityEpoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    });
    const diagnostics = store.getDiagnostics();
    const maintenance = store.maintain(2);

    worker.reply(0, []);
    await replay;
    expect(worker.posted[1]?.request.method).toBe("maintain");
    worker.reply(1, {
      state: "idle",
      lastCheckpointAt: "2026-01-01T00:00:00.000Z",
      busy: false,
      logFrames: 1,
      checkpointedFrames: 1,
      autoVacuumMode: "incremental",
      freelistPagesBefore: 2,
      freelistPagesAfter: 1,
      requestedReclaimPages: 2,
    });
    await maintenance;
    expect(worker.posted[2]?.request.method).toBe("getDiagnostics");
    worker.reply(2, {});
    await diagnostics;
    await store.close();
  });

  it("closes under full capacity without stranding queued reads", async () => {
    const worker = new FakeWorker();
    const store = new WorkerJournalStore("unused.sqlite", { worker, maxPending: 2 });

    const activeRead = store.getDiagnostics();
    const queuedRead = store.getAgentById(agentId);
    const closing = store.close();

    await expect(queuedRead).rejects.toThrow(/closing/i);
    await expect(store.listAgents()).rejects.toThrow(/closing/i);
    expect(store.close()).toBe(closing);
    expect(worker.posted.map(({ request }) => request.method)).toEqual(["getDiagnostics"]);

    worker.reply(0, {});
    await activeRead;
    await closing;
    expect(worker.posted.map(({ request }) => request.method)).toEqual(["getDiagnostics", "close"]);
    expect(worker.terminateCalls).toBe(1);
    await expect(store.getDiagnostics()).rejects.toThrow(/closed/i);
  });

  it("turns worker failure into terminal storage health failure", async () => {
    const worker = new FakeWorker();
    const failures: Error[] = [];
    const store = new WorkerJournalStore("unused.sqlite", {
      worker,
      maxPending: 2,
      onHealthFailure: (error) => failures.push(error),
    });
    const pending = store.getDiagnostics();
    worker.emit("error", new Error("worker failed"));

    await expect(pending).rejects.toThrow("worker failed");
    await expect(store.getDiagnostics()).rejects.toThrow("worker failed");
    await expect(store.close()).resolves.toBeUndefined();
    expect(worker.terminateCalls).toBe(1);
    expect(failures).toEqual([expect.objectContaining({ message: "worker failed" })]);
  });

  it("allows only one outstanding range read per reader and transfers copied record bytes", async () => {
    const worker = new FakeWorker();
    const store = new WorkerJournalStore("unused.sqlite", { worker, maxPending: 4 });
    const read = store.readEventsForReader("reader-1", {
      agentId,
      epoch: 1 as ContinuityEpoch,
      afterPosition: 0,
      limit: 10,
      maxBytes: 10_000,
      maxEventBytes: 10_000,
    });
    await expect(
      store.readEventsForReader("reader-1", {
        agentId,
        epoch: 1 as ContinuityEpoch,
        afterPosition: 10,
        limit: 10,
        maxBytes: 10_000,
        maxEventBytes: 10_000,
      }),
    ).rejects.toThrow(/already has an outstanding/i);
    worker.reply(0, []);
    await read;

    const original = Buffer.from([0xff, 0x00, 0x0a]);
    const append = store.append({
      agentId,
      incarnationId: "incarnation-1" as IncarnationId,
      epoch: 1 as ContinuityEpoch,
      records: [
        {
          agentId,
          incarnationId: "incarnation-1" as IncarnationId,
          position: 1,
          observedAt: "2026-01-01T00:00:00.000Z",
          bytes: original,
        },
      ],
      events: [],
      projectorState: {
        version: 1,
        messageSequence: 0,
        finishedThinkingIndexes: [],
        openActivities: [],
      },
      highWater: { rawPosition: 1, eventPosition: 0, idleEventPosition: null },
    });
    const posted = worker.posted[1];
    expect(posted?.transfers).toHaveLength(1);
    expect(original).toEqual(Buffer.from([0xff, 0x00, 0x0a]));
    worker.reply(1, undefined);
    await append;
    await store.close();
  });
});
