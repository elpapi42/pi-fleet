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
  it("streams exact RPC stdout to a watcher attached before restoration", async () => {
    const raw = Buffer.from(
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"why"}}\n',
    );
    let starts = 0;
    const launcher: PiLauncher = {
      artifactId: "streaming-pi",
      async start(_profile, _restore, _onSpawn, onStdoutBytes): Promise<PiProcess> {
        starts += 1;
        if (starts === 2) onStdoutBytes?.(raw);
        return fakeProcess(40_000 + starts);
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    await service.releaseAgentProcess("reviewer");
    const abort = new AbortController();
    const watch = await service.openWatch({ name: "reviewer" }, abort.signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const iterator = watch.value[Symbol.asyncIterator]();

    await service.send({ name: "reviewer", message: "continue" }, "send-reviewer");

    expect((await iterator.next()).value).toEqual(raw);
    abort.abort();
    await service.close();
  });

  it("streams future RPC stdout from an already resident incarnation", async () => {
    let publish: ((bytes: Buffer) => void) | undefined;
    const launcher: PiLauncher = {
      artifactId: "resident-streaming-pi",
      async start(_profile, _restore, _onSpawn, onStdoutBytes): Promise<PiProcess> {
        publish = onStdoutBytes;
        return fakeProcess(41_000);
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    const abort = new AbortController();
    const watch = await service.openWatch({ name: "reviewer" }, abort.signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const iterator = watch.value[Symbol.asyncIterator]();
    const raw = Buffer.from("not-json\r\n");

    publish?.(raw);

    expect((await iterator.next()).value).toEqual(raw);
    abort.abort();
    await service.close();
  });

  it("allows passive watch before a native session file exists", async () => {
    const service = new FleetService(new MemoryFleetStore());
    await service.create({ name: "promptless", cwd: "/tmp", piArgv: [] }, "create-promptless");
    const abort = new AbortController();

    const watch = await service.openWatch({ name: "promptless" }, abort.signal);

    expect(watch.ok).toBe(true);
    abort.abort();
    await service.close();
  });

  it("forwards Pi stdout emitted during destroy before ending the watch", async () => {
    const shutdownBytes = Buffer.from(
      '{"type":"extension_ui_request","method":"setStatus","statusText":"stopping"}\n',
    );
    let exitListener: ((error: Error | null) => void) | undefined;
    const launcher: PiLauncher = {
      artifactId: "shutdown-streaming-pi",
      async start(_profile, _restore, _onSpawn, onStdoutBytes): Promise<PiProcess> {
        return {
          pid: 41_500,
          async getState() {
            return {
              isStreaming: false,
              isCompacting: false,
              pendingMessageCount: 0,
              sessionFile: "/tmp/shutdown-stream.jsonl",
              sessionId: "shutdown-stream",
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
            onStdoutBytes?.(shutdownBytes);
            exitListener?.(null);
            await Promise.resolve();
          },
        } as unknown as PiProcess;
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    const created = await service.create(
      { name: "reviewer", cwd: "/tmp", piArgv: [] },
      "create-reviewer",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const watch = await service.openWatch({ name: "reviewer" }, new AbortController().signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const iterator = watch.value[Symbol.asyncIterator]();

    await expect(service.destroy({ name: "reviewer" }, "destroy-reviewer")).resolves.toMatchObject({
      ok: true,
    });

    expect((await iterator.next()).value).toEqual(shutdownBytes);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await service.close();
  });

  it("does not admit an orphan watch after destroy has started", async () => {
    let exitListener: ((error: Error | null) => void) | undefined;
    let releaseStop!: () => void;
    let markStopping!: () => void;
    const stopping = new Promise<void>((resolve) => (markStopping = resolve));
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const launcher: PiLauncher = {
      artifactId: "destroy-race-pi",
      async start(): Promise<PiProcess> {
        return {
          ...fakeProcess(41_600),
          onExit(listener: (error: Error | null) => void) {
            exitListener = listener;
            return () => undefined;
          },
          async stop() {
            markStopping();
            await stopGate;
            exitListener?.(null);
          },
        } as unknown as PiProcess;
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    const destroying = service.destroy({ name: "reviewer" }, "destroy-reviewer");
    await stopping;

    await expect(
      service.openWatch({ name: "reviewer" }, new AbortController().signal),
    ).resolves.toMatchObject({ ok: false, error: { code: "agent_destroying" } });

    releaseStop();
    await expect(destroying).resolves.toMatchObject({ ok: true });
    await expect(
      service.openWatch({ name: "reviewer" }, new AbortController().signal),
    ).resolves.toMatchObject({ ok: false, error: { code: "agent_not_found" } });
    await service.close();
  });

  it("closes a registered watch when destroy wins after registration", async () => {
    const service = new FleetService(new MemoryFleetStore(), { launcher: fakeLauncher() });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    const watch = await service.openWatch({ name: "reviewer" }, new AbortController().signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const iterator = watch.value[Symbol.asyncIterator]();

    await service.destroy({ name: "reviewer" }, "destroy-reviewer");

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await service.close();
  });

  it("ends a watch at its bound Pi incarnation instead of rebinding it", async () => {
    let publish: ((bytes: Buffer) => void) | undefined;
    const launcher: PiLauncher = {
      artifactId: "incarnation-pi",
      async start(_profile, _restore, _onSpawn, onStdoutBytes): Promise<PiProcess> {
        publish = onStdoutBytes;
        return fakeProcess(42_000);
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    const watch = await service.openWatch({ name: "reviewer" }, new AbortController().signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const iterator = watch.value[Symbol.asyncIterator]();
    publish?.(Buffer.from("last bytes"));

    await service.releaseAgentProcess("reviewer");

    expect((await iterator.next()).value?.toString()).toBe("last bytes");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await service.send({ name: "reviewer", message: "restore" }, "send-reviewer");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await service.close();
  });

  it("fails a pre-start watch when restoration cannot start Pi", async () => {
    let starts = 0;
    const launcher: PiLauncher = {
      artifactId: "failed-streaming-pi",
      async start(): Promise<PiProcess> {
        starts += 1;
        if (starts > 1) throw new Error("spawn failed");
        return fakeProcess(43_000);
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");
    await service.releaseAgentProcess("reviewer");
    const watch = await service.openWatch({ name: "reviewer" }, new AbortController().signal);
    expect(watch.ok).toBe(true);
    if (!watch.ok) throw new Error("watch failed");
    const next = watch.value[Symbol.asyncIterator]().next();

    expect(
      await service.send({ name: "reviewer", message: "restore" }, "send-reviewer"),
    ).toMatchObject({
      ok: false,
      error: { code: "pi_start_failed" },
    });
    await expect(next).rejects.toMatchObject({ code: "pi_start_failed" });
    await service.close();
  });

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

  it("keeps an idle agent recoverable when orderly shutdown observes a nonzero Pi exit", async () => {
    const store = new MemoryFleetStore();
    const launcher: PiLauncher = {
      artifactId: "idle-shutdown-pi",
      async start() {
        const process = fakeProcess(25_500) as unknown as {
          onExit(listener: (error: Error | null) => void): () => void;
          stop(): Promise<void>;
        };
        let exitListener: ((error: Error | null) => void) | undefined;
        process.onExit = (listener) => {
          exitListener = listener;
          return () => undefined;
        };
        process.stop = async () => exitListener?.(new Error("Pi exited with code 1"));
        return process as PiProcess;
      },
    };
    const service = new FleetService(store, { launcher });
    await service.create({ name: "idle", cwd: "/tmp", piArgv: [] }, "create-idle");

    await service.close();

    expect(await store.getAgent("idle")).toMatchObject({
      summary: {
        state: "idle",
        process: { state: "absent" },
        error: undefined,
      },
    });
  });

  it("rejects watch registration after runtime shutdown begins", async () => {
    const service = new FleetService(new MemoryFleetStore());
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-reviewer");

    await service.close();

    await expect(
      service.openWatch({ name: "reviewer" }, new AbortController().signal),
    ).resolves.toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
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
