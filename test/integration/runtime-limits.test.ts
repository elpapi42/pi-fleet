import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

function fakeLauncher(): PiLauncher {
  let pid = 10_000;
  return {
    artifactId: "fake-pi",
    async start(): Promise<PiProcess> {
      return fakeProcess(pid++);
    },
  };
}

function controlledLauncher(): {
  readonly launcher: PiLauncher;
  readonly starts: () => number;
  holdNextStart(): { readonly started: Promise<void>; release(): void };
} {
  let count = 0;
  let gate: { readonly started: () => void; readonly wait: Promise<void> } | null = null;
  return {
    starts: () => count,
    holdNextStart() {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      gate = { started: markStarted, wait };
      return { started, release };
    },
    launcher: {
      artifactId: "controlled-pi",
      async start(): Promise<PiProcess> {
        count += 1;
        const currentGate = gate;
        gate = null;
        if (currentGate !== null) {
          currentGate.started();
          await currentGate.wait;
        }
        return fakeProcess(20_000 + count);
      },
    },
  };
}

function fakeProcess(pid: number): PiProcess {
  let exitListener: ((error: Error | null) => void) | undefined;
  return {
    pid,
    async getState() {
      return {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: `/tmp/session-${String(pid)}.jsonl`,
        sessionId: `session-${String(pid)}`,
      };
    },
    async prompt() {},
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
      await Promise.resolve();
    },
  } as unknown as PiProcess;
}

describe("runtime admission limits", () => {
  it("rejects a process-starting create when resident capacity is full", async () => {
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: fakeLauncher(),
      limits: { maxResidentProcesses: 1 },
    });

    expect(
      await service.create({ name: "one", cwd: "/tmp", piArgv: [] }, "create-one"),
    ).toMatchObject({ ok: true });
    expect(
      await service.create({ name: "two", cwd: "/tmp", piArgv: [] }, "create-two"),
    ).toMatchObject({ ok: false, error: { code: "capacity_exceeded" } });
    await service.close();
  });

  it("single-flights restoration so concurrent sends cannot start two Pi writers", async () => {
    const controlled = controlledLauncher();
    const service = new FleetService(new MemoryFleetStore(), { launcher: controlled.launcher });
    await service.create(
      { name: "one", cwd: "/tmp", piArgv: ["--session", "/tmp/one.jsonl"] },
      "create-one",
    );
    await service.releaseAgentProcess("one");

    const gate = controlled.holdNextStart();
    const first = service.send({ name: "one", message: "first" }, "send-one");
    await gate.started;
    const second = await service.send({ name: "one", message: "second" }, "send-two");
    expect(second).toMatchObject({ ok: false, error: { code: "agent_restoring" } });
    gate.release();
    expect(await first).toMatchObject({ ok: true });
    expect(controlled.starts()).toBe(2);
    await service.close();
  });

  it("rejects messages over the configured byte limit", async () => {
    const service = new FleetService(new MemoryFleetStore(), {
      limits: { maxMessageBytes: 3 },
    });
    await service.create({ name: "one", cwd: "/tmp", piArgv: [] }, "create-one");

    expect(await service.send({ name: "one", message: "four" }, "send-one")).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });
});
