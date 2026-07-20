import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

interface ResourceSample {
  readonly heapUsed: number;
  readonly rss: number;
  readonly fileDescriptors: number | null;
}

async function sampleResources(): Promise<ResourceSample> {
  const fileDescriptors =
    process.platform === "linux" ? (await readdir("/proc/self/fd")).length : null;
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    fileDescriptors,
  };
}

function stableLauncher() {
  let starts = 0;
  let stops = 0;
  let prompts = 0;
  const live = new Set<number>();

  const launcher: PiLauncher = {
    artifactId: "resource-soak-pi",
    async start() {
      const pid = 60_000 + ++starts;
      live.add(pid);
      let exitListener: ((error: Error | null) => void) | undefined;
      return {
        pid,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: "/tmp/resource-stability-session.jsonl",
            sessionId: "resource-stability-session",
          };
        },
        async prompt() {
          prompts += 1;
        },
        async getLastAssistantText() {
          return null;
        },
        onFrame() {
          return () => undefined;
        },
        onExit(listener: (error: Error | null) => void) {
          exitListener = listener;
          return () => undefined;
        },
        async stop() {
          if (!live.delete(pid)) return;
          stops += 1;
          exitListener?.(null);
        },
      } as unknown as PiProcess;
    },
  };

  return {
    launcher,
    starts: () => starts,
    stops: () => stops,
    prompts: () => prompts,
    live: () => live.size,
  };
}

describe("resource stability soak", () => {
  it("returns in-process Fleet resources to a stable post-cleanup baseline", async () => {
    const store = new MemoryFleetStore();
    const pi = stableLauncher();
    const service = new FleetService(store, { launcher: pi.launcher });
    const baseline = await sampleResources();
    const samples: ResourceSample[] = [];
    const rounds = 24;
    const sendsPerRound = 12;

    try {
      for (let round = 0; round < rounds; round += 1) {
        const name = `resource-${String(round)}`;
        await expect(
          service.create({ name, cwd: "/tmp", piArgv: [] }, `create-${String(round)}`),
        ).resolves.toMatchObject({ ok: true });

        await expect(
          Promise.all(
            Array.from({ length: sendsPerRound }, (_, index) =>
              service.send(
                { name, message: `resource-message-${String(round)}-${String(index)}` },
                `send-${String(round)}-${String(index)}`,
              ),
            ),
          ),
        ).resolves.toSatisfy((results: readonly { readonly ok: boolean }[]) =>
          results.every((result) => result.ok),
        );

        await expect(service.status({ name })).resolves.toMatchObject({ ok: true });
        await expect(service.destroy({ name }, `destroy-${String(round)}`)).resolves.toMatchObject({
          ok: true,
        });

        await expect(store.listAgents()).resolves.toEqual([]);
        await expect(store.listNonterminalSends()).resolves.toEqual([]);
        await expect(store.listPendingOperations()).resolves.toEqual([]);
        await expect(store.listActiveIncarnations()).resolves.toEqual([]);
        expect(pi.live()).toBe(0);
        expect(pi.starts()).toBe(pi.stops());
        samples.push(await sampleResources());
      }
    } finally {
      await service.close();
    }

    expect(pi.prompts()).toBe(rounds * sendsPerRound);
    expect(pi.starts()).toBe(rounds);
    expect(pi.stops()).toBe(rounds);
    expect(pi.live()).toBe(0);

    const final = samples.at(-1);
    expect(final).toBeDefined();
    if (final === undefined) return;

    if (baseline.fileDescriptors !== null && final.fileDescriptors !== null) {
      expect(final.fileDescriptors).toBeLessThanOrEqual(baseline.fileDescriptors + 8);
    }

    // This only catches gross monotonic leaks in the in-process fake-Pi path. It is not a capacity claim.
    expect(final.heapUsed).toBeLessThanOrEqual(baseline.heapUsed + 48 * 1024 * 1024);
    expect(final.rss).toBeLessThanOrEqual(baseline.rss + 96 * 1024 * 1024);

    const highWater = {
      heapUsed: Math.max(...samples.map((sample) => sample.heapUsed)),
      rss: Math.max(...samples.map((sample) => sample.rss)),
      fileDescriptors:
        baseline.fileDescriptors === null
          ? null
          : Math.max(...samples.map((sample) => sample.fileDescriptors ?? 0)),
    };
    process.stdout.write(
      `resource-stability ${JSON.stringify({ baseline, final, highWater, rounds, sendsPerRound })}\n`,
    );
    expect(samples).toHaveLength(rounds);
  });
});
