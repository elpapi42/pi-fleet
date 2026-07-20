import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeProcess(promptGate?: ReturnType<typeof deferred>): PiProcess {
  let exitListener: ((error: Error | null) => void) | undefined;
  return {
    pid: 42_000,
    async getState() {
      return {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: "/tmp/race-session.jsonl",
        sessionId: "race-session",
      };
    },
    async prompt() {
      await promptGate?.promise;
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
}

describe("cross-command serialization", () => {
  it("lets destroy wait for an in-flight create and removes the created generation", async () => {
    const startGate = deferred();
    const started = deferred();
    const launcher: PiLauncher = {
      artifactId: "race-pi",
      async start() {
        started.resolve();
        await startGate.promise;
        return fakeProcess();
      },
    };
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher });

    const creating = service.create({ name: "race", cwd: "/tmp", piArgv: [] }, "create-race");
    await started.promise;
    const destroying = service.destroy({ name: "race" }, "destroy-race");
    startGate.resolve();

    await expect(creating).resolves.toMatchObject({ ok: true });
    await expect(destroying).resolves.toMatchObject({ ok: true });
    await expect(service.status({ name: "race" })).resolves.toMatchObject({
      ok: false,
      error: { code: "agent_not_found" },
    });
    await service.close();
  });

  it("lets destroy wait for an acknowledged in-flight send", async () => {
    const promptGate = deferred();
    const promptStarted = deferred();
    const process = fakeProcess(promptGate) as unknown as PiProcess & {
      prompt(message: string): Promise<void>;
    };
    const originalPrompt = process.prompt.bind(process);
    process.prompt = async (message) => {
      promptStarted.resolve();
      await originalPrompt(message);
    };
    const launcher: PiLauncher = {
      artifactId: "race-pi",
      async start() {
        return process;
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "race", cwd: "/tmp", piArgv: [] }, "create-race");

    const sending = service.send({ name: "race", message: "work" }, "send-race");
    await promptStarted.promise;
    const destroying = service.destroy({ name: "race" }, "destroy-race");
    promptGate.resolve();

    await expect(sending).resolves.toMatchObject({ ok: true });
    await expect(destroying).resolves.toMatchObject({ ok: true });
    await expect(service.status({ name: "race" })).resolves.toMatchObject({ ok: false });
    await service.close();
  });
});
