import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { WorkerFleetStore } from "../../src/store/worker-store.js";

it("records the main-thread SQLite baseline", async () => {
  const operations = 1_000;
  const root = await mkdtemp(join(tmpdir(), "pifleet-store-benchmark-"));
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const workerUrl = new URL("../../dist/sqlite-worker.mjs", import.meta.url);
  const store = new WorkerFleetStore(join(root, "fleet.sqlite"), workerUrl);
  const started = performance.now();

  try {
    for (let index = 0; index < operations; index += 1) {
      const name = `agent-${String(index).padStart(4, "0")}`;
      await store.createAgent({
        summary: {
          id: `id-${index}`,
          name,
          state: "idle",
          process: { state: "absent" },
          session: { path: null, id: null },
        },
        launch: createLaunchProfile({ cwd: root, piArgv: [], piArtifactId: "benchmark" }),
        latestAssistantText: null,
        responseObservedAt: null,
      });
      await store.putOperation({
        operationId: `operation-${index}`,
        method: "create",
        fingerprint: name,
        state: "completed",
        result: { ok: true },
      });
      if (index % 25 === 0) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    const elapsedMs = performance.now() - started;
    histogram.disable();
    const result = {
      logicalOperations: operations,
      sqliteMutations: operations * 2,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      mutationsPerSecond: Number(((operations * 2 * 1000) / elapsedMs).toFixed(2)),
      eventLoopDelayMs: {
        mean: Number((histogram.mean / 1e6).toFixed(3)),
        p99: Number((histogram.percentile(99) / 1e6).toFixed(3)),
        max: Number((histogram.max / 1e6).toFixed(3)),
      },
    };
    process.stdout.write(`STORE_BENCHMARK ${JSON.stringify(result)}\n`);
    expect(await store.listAgents()).toHaveLength(operations);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
