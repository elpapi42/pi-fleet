import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import { PiCleanupUncertainError, type PiProcess } from "../../src/pi/process.js";
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

function settleDuringReceiveLauncher(): PiLauncher {
  return {
    artifactId: "settle-race-pi",
    async start(): Promise<PiProcess> {
      let stateCalls = 0;
      let frameListener: ((frame: { type: string }) => void) | undefined;
      let exitListener: ((error: Error | null) => void) | undefined;
      return {
        pid: 30_000,
        async getState() {
          stateCalls += 1;
          if (stateCalls > 1) frameListener?.({ type: "agent_settled" });
          return {
            isStreaming: stateCalls > 1,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: "/tmp/settle-race.jsonl",
            sessionId: "settle-race",
          };
        },
        async prompt() {},
        async getLastAssistantText() {
          return "settled response";
        },
        onFrame(listener: (frame: { type: string }) => void) {
          frameListener = listener;
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
}

describe("runtime admission limits", () => {
  it("returns and remembers invalid Pi startup arguments as a domain error", async () => {
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: fakeLauncher() });
    const input = { name: "invalid", cwd: "/tmp", piArgv: ["positional-prompt"] };

    const first = await service.create(input, "create-invalid");
    const retry = await service.create(input, "create-invalid");

    expect(first).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(retry).toEqual(first);
    expect(await store.getAgent("invalid")).toBeNull();
    await service.close();
  });

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

  it("attaches a matching retry to one in-flight mutation", async () => {
    const controlled = controlledLauncher();
    const gate = controlled.holdNextStart();
    const service = new FleetService(new MemoryFleetStore(), { launcher: controlled.launcher });
    const input = { name: "one", cwd: "/tmp", piArgv: [] };

    const first = service.create(input, "same-operation");
    await gate.started;
    const retry = service.create(input, "same-operation");
    gate.release();
    const [firstResult, retryResult] = await Promise.all([first, retry]);

    expect(retryResult).toEqual(firstResult);
    expect(controlled.starts()).toBe(1);
    await service.close();
  });

  it("single-flights restoration so concurrent sends cannot start two Pi writers", async () => {
    const controlled = controlledLauncher();
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: controlled.launcher });
    await service.create(
      { name: "one", cwd: "/tmp", piArgv: ["--session", "/tmp/one.jsonl"] },
      "create-one",
    );
    await service.releaseAgentProcess("one");

    const gate = controlled.holdNextStart();
    const first = service.send({ name: "one", message: "first" }, "send-one");
    await gate.started;
    const second = service.send({ name: "one", message: "second" }, "send-two");
    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: true });
    expect(await store.getSend("send-one")).toMatchObject({ ordinal: 1, state: "acknowledged" });
    expect(await store.getSend("send-two")).toMatchObject({ ordinal: 2, state: "acknowledged" });
    expect(controlled.starts()).toBe(2);
    await service.close();
  });

  it("reports a proven restoration startup failure without claiming delivery uncertainty", async () => {
    let starts = 0;
    const store = new MemoryFleetStore();
    const service = new FleetService(store, {
      launcher: {
        artifactId: "restore-failure-pi",
        async start() {
          starts += 1;
          if (starts === 1) return fakeProcess(24_000);
          throw new Error("spawn ENOENT");
        },
      },
    });
    await service.create({ name: "missing-cwd", cwd: "/tmp", piArgv: [] }, "create-one");
    await service.releaseAgentProcess("missing-cwd");

    expect(await service.send({ name: "missing-cwd", message: "work" }, "send-one")).toMatchObject({
      ok: false,
      error: { code: "pi_start_failed" },
    });
    expect(await store.getSend("send-one")).toMatchObject({ state: "failed" });
    expect(await service.status({ name: "missing-cwd" })).toMatchObject({
      ok: true,
      value: {
        agent: {
          state: "failed",
          process: { state: "absent" },
          error: { code: "pi_start_failed" },
        },
      },
    });
    await service.close();
  });

  it("retains restoration cleanup uncertainty when the failed process may survive", async () => {
    let starts = 0;
    const store = new MemoryFleetStore();
    const service = new FleetService(store, {
      launcher: {
        artifactId: "restore-cleanup-pi",
        async start() {
          starts += 1;
          if (starts === 1) return fakeProcess(24_100);
          throw new PiCleanupUncertainError(
            24_101,
            new Error("readiness failed"),
            new Error("still alive"),
          );
        },
      },
    });
    await service.create({ name: "unclean-restore", cwd: "/tmp", piArgv: [] }, "create-one");
    await service.releaseAgentProcess("unclean-restore");

    expect(
      await service.send({ name: "unclean-restore", message: "work" }, "send-one"),
    ).toMatchObject({ ok: false, error: { code: "incarnation_cleanup_uncertain" } });
    expect(await store.getSend("send-one")).toMatchObject({ state: "failed" });
    expect(await service.status({ name: "unclean-restore" })).toMatchObject({
      ok: true,
      value: {
        agent: {
          state: "failed",
          process: { state: "cleanup_uncertain" },
          error: { code: "incarnation_cleanup_uncertain" },
        },
      },
    });
  });

  it("preserves a failed agent when instructed create delivery is ambiguous", async () => {
    const launcher: PiLauncher = {
      artifactId: "ambiguous-pi",
      async start() {
        const process = fakeProcess(25_000) as unknown as {
          prompt(message: string): Promise<void>;
        };
        process.prompt = async () => {
          throw new Error("Pi RPC request timed out");
        };
        return process as PiProcess;
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });

    expect(
      await service.create(
        { name: "ambiguous", instructions: "do work", cwd: "/tmp", piArgv: [] },
        "create-ambiguous",
      ),
    ).toMatchObject({ ok: false, error: { code: "delivery_uncertain" } });
    expect(await service.status({ name: "ambiguous" })).toMatchObject({
      ok: true,
      value: {
        agent: {
          state: "failed",
          process: { state: "absent" },
          error: { code: "delivery_uncertain" },
        },
      },
    });
  });

  it("preserves cleanup uncertainty when startup cannot terminate the spawned group", async () => {
    const launcher: PiLauncher = {
      artifactId: "unclean-pi",
      async start() {
        throw new PiCleanupUncertainError(
          25_001,
          new Error("readiness failed"),
          new Error("alive"),
        );
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });

    expect(
      await service.create({ name: "unclean", cwd: "/tmp", piArgv: [] }, "create-unclean"),
    ).toMatchObject({ ok: false, error: { code: "incarnation_cleanup_uncertain" } });
    expect(await service.status({ name: "unclean" })).toMatchObject({
      ok: true,
      value: { agent: { state: "failed", process: { state: "cleanup_uncertain" } } },
    });
  });

  it("marks active work interrupted during orderly runtime shutdown", async () => {
    let frameListener: ((frame: { type: string }) => void) | undefined;
    const launcher: PiLauncher = {
      artifactId: "active-pi",
      async start() {
        const process = fakeProcess(26_000) as unknown as {
          prompt(message: string): Promise<void>;
          onFrame(listener: (frame: { type: string }) => void): () => void;
        };
        process.onFrame = (listener) => {
          frameListener = listener;
          return () => undefined;
        };
        process.prompt = async () => frameListener?.({ type: "agent_start" });
        return process as PiProcess;
      },
    };
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher });
    await service.create({ name: "active", cwd: "/tmp", piArgv: [] }, "create-active");
    await service.send({ name: "active", message: "work" }, "send-active");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.close();

    expect(await store.getAgent("active")).toMatchObject({
      summary: {
        state: "failed",
        process: { state: "absent" },
        error: { code: "runtime_interrupted" },
      },
    });
  });

  it("does not miss settlement between receive state inspection and waiter registration", async () => {
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: settleDuringReceiveLauncher(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    await service.create({ name: "one", cwd: "/tmp", piArgv: [] }, "create-one");
    await service.send({ name: "one", message: "work" }, "send-one");

    await expect(service.receive({ name: "one" })).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "settled response" } },
    });
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
