import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import type {
  AgentId,
  ContinuityEpoch,
  IncarnationId,
  ProjectorState,
} from "../../src/runtime/semantic-events.js";
import { WorkerJournalStore } from "../../src/store/worker-journal-store.js";

const PROJECTOR_STATE: ProjectorState = {
  version: 1,
  messageSequence: 0,
  finishedThinkingIndexes: [],
  openActivities: [],
};

/**
 * Measures the durable-before-parse append path that now gates Pi RPC throughput:
 * batched raw stdout records committed through the journal worker thread.
 */
it("records the journal worker append baseline", async () => {
  const batches = 200;
  const recordsPerBatch = 5;
  const agentId = "11111111-1111-4111-8111-111111111111" as AgentId;
  const incarnationId = "22222222-2222-4222-8222-222222222222" as IncarnationId;
  const epoch = 1 as ContinuityEpoch;
  const root = await mkdtemp(join(tmpdir(), "pifleet-journal-benchmark-"));
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const store = new WorkerJournalStore(join(root, "fleet.sqlite"), {
    workerUrl: new URL("../../dist/journal-sqlite-worker.mjs", import.meta.url),
  });

  try {
    await store.createAgent({
      agentId,
      name: "reviewer",
      summary: {
        id: agentId,
        name: "reviewer",
        state: "idle",
        process: { state: "absent" },
        session: { path: null, id: null },
      },
      launch: createLaunchProfile({ cwd: root, piArgv: [] }),
    });
    await store.putEpoch({
      agentId,
      epoch,
      state: "open",
      lastSafeEventPosition: 0,
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.putIncarnation({ incarnationId, agentId, pid: 1234, state: "live" });
    await store.beginIncarnation(agentId, incarnationId, epoch, PROJECTOR_STATE);

    const started = performance.now();
    let position = 0;
    for (let batch = 0; batch < batches; batch += 1) {
      const records = Array.from({ length: recordsPerBatch }, (_unused, index) => {
        position += 1;
        return {
          agentId,
          incarnationId,
          position,
          observedAt: "2026-01-01T00:00:00.000Z",
          bytes: Buffer.from(
            `${JSON.stringify({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: `chunk-${String(batch)}-${String(index)}`,
              },
            })}\n`,
          ),
        };
      });
      await store.append({
        agentId,
        incarnationId,
        epoch,
        records,
        events: [],
        projectorState: PROJECTOR_STATE,
        highWater: { rawPosition: position, eventPosition: 0, idleEventPosition: null },
      });
      if (batch % 25 === 0) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    const elapsedMs = performance.now() - started;
    histogram.disable();
    const totalRecords = batches * recordsPerBatch;
    process.stdout.write(
      `STORE_BENCHMARK ${JSON.stringify({
        commits: batches,
        rawRecords: totalRecords,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        recordsPerSecond: Number(((totalRecords * 1000) / elapsedMs).toFixed(2)),
        eventLoopDelayMs: {
          mean: Number((histogram.mean / 1e6).toFixed(3)),
          p99: Number((histogram.percentile(99) / 1e6).toFixed(3)),
          max: Number((histogram.max / 1e6).toFixed(3)),
        },
      })}\n`,
    );

    const highWater = await store.getHighWater(agentId);
    expect(highWater?.rawPosition).toBe(totalRecords);
    expect(await store.getRawRecords(agentId, totalRecords - 1, 10)).toHaveLength(1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
