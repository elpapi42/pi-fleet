import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

function countingLauncher() {
  let starts = 0;
  let prompts = 0;
  const launcher: PiLauncher = {
    artifactId: "soak-pi",
    async start() {
      starts += 1;
      let exitListener: ((error: Error | null) => void) | undefined;
      return {
        pid: 50_000 + starts,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: "/tmp/soak-session.jsonl",
            sessionId: "soak-session",
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
          exitListener?.(null);
        },
      } as unknown as PiProcess;
    },
  };
  return { launcher, starts: () => starts, prompts: () => prompts };
}

describe("reliability soak", () => {
  it("accepts 500 concurrent sends in strict durable order through one Pi process", async () => {
    const store = new MemoryFleetStore();
    const pi = countingLauncher();
    const service = new FleetService(store, { launcher: pi.launcher });
    await service.create({ name: "soak", cwd: "/tmp", piArgv: [] }, "create-soak");

    const sends = Array.from({ length: 500 }, (_, index) =>
      service.send({ name: "soak", message: `message-${String(index)}` }, `send-${String(index)}`),
    );
    const results = await Promise.all(sends);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(pi.starts()).toBe(1);
    expect(pi.prompts()).toBe(500);
    const stored = await Promise.all(
      Array.from({ length: 500 }, (_, index) => store.getSend(`send-${String(index)}`)),
    );
    expect(stored.map((send) => send?.ordinal)).toEqual(
      Array.from({ length: 500 }, (_, index) => index + 1),
    );
    await service.close();
  });

  it("releases names across 100 create/destroy cycles without deleting external state", async () => {
    const store = new MemoryFleetStore();
    const service = new FleetService(store);
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index);
      await expect(
        service.create({ name: "cycle", cwd: "/tmp", piArgv: [] }, `create-${suffix}`),
      ).resolves.toMatchObject({ ok: true });
      await expect(service.destroy({ name: "cycle" }, `destroy-${suffix}`)).resolves.toMatchObject({
        ok: true,
      });
    }
    await expect(service.list()).resolves.toMatchObject({ ok: true, value: { agents: [] } });
    await service.close();
  });
});
