import { describe, expect, it, vi } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import { PiCompactionError, type PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import type { StoredOperation } from "../../src/store/fleet-store.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

interface ControlledProcess {
  readonly process: PiProcess;
  readonly compactCalls: () => number;
  readonly promptCalls: () => number;
  readonly stopCalls: () => number;
  setState(state: {
    readonly isStreaming?: boolean;
    readonly isCompacting?: boolean;
    readonly pendingMessageCount?: number;
  }): void;
  rejectCompaction(error: Error): void;
  holdCompaction(): { readonly started: Promise<void>; release(): void };
  holdStop(): { readonly release: () => void };
  exit(error?: Error): void;
}

function controlledProcess(pid: number): ControlledProcess {
  let exitListener: ((error: Error | null) => void) | undefined;
  let compactions = 0;
  let prompts = 0;
  let stops = 0;
  let state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  let compactionError: Error | null = null;
  let compactionGate: {
    readonly started: () => void;
    readonly wait: Promise<void>;
    readonly stop: () => void;
  } | null = null;
  let stopGate: Promise<void> | null = null;

  return {
    process: {
      pid,
      async getState() {
        return {
          ...state,
          sessionFile: `/tmp/compact-${String(pid)}.jsonl`,
          sessionId: `compact-${String(pid)}`,
        };
      },
      async prompt() {
        prompts += 1;
      },
      async compact() {
        compactions += 1;
        if (compactionError !== null) throw compactionError;
        const gate = compactionGate;
        if (gate !== null) {
          state = { ...state, isCompacting: true };
          gate.started();
          await gate.wait;
          state = { ...state, isCompacting: false };
        }
        return { tokensBefore: 1200, estimatedTokensAfter: 300 };
      },
      async getLastAssistantText() {
        return "previous response";
      },
      onFrame() {
        return () => undefined;
      },
      onExit(listener: (error: Error | null) => void) {
        exitListener = listener;
        return () => {
          exitListener = undefined;
        };
      },
      async stop() {
        stops += 1;
        compactionGate?.stop();
        if (stopGate !== null) await stopGate;
        exitListener?.(null);
      },
    } as unknown as PiProcess,
    compactCalls: () => compactions,
    promptCalls: () => prompts,
    stopCalls: () => stops,
    setState(next) {
      state = { ...state, ...next };
    },
    rejectCompaction(error) {
      compactionError = error;
    },
    holdCompaction() {
      let markStarted!: () => void;
      let release!: () => void;
      let reject!: (error: Error) => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const wait = new Promise<void>((resolve, rejectWait) => {
        release = resolve;
        reject = rejectWait;
      });
      compactionGate = {
        started: markStarted,
        wait,
        stop: () => reject(new Error("Pi process stopped")),
      };
      return { started, release };
    },
    holdStop() {
      let release!: () => void;
      stopGate = new Promise<void>((resolve) => (release = resolve));
      return { release };
    },
    exit(error) {
      exitListener?.(error ?? null);
    },
  };
}

function launcherFor(...processes: ControlledProcess[]): PiLauncher {
  let index = 0;
  return {
    artifactId: "compact-test-pi",
    async start() {
      const next = processes[index++];
      if (next === undefined) throw new Error("unexpected Pi start");
      return next.process;
    },
  };
}

class OneShotCompactResultFailureStore extends MemoryFleetStore {
  #failed = false;

  override async putOperation(operation: StoredOperation): Promise<void> {
    if (!this.#failed && operation.method === "compact" && operation.state === "completed") {
      this.#failed = true;
      throw new Error("injected operation result failure");
    }
    await super.putOperation(operation);
  }
}

describe("compact lifecycle", () => {
  it("uses native Pi compaction and returns bounded token metrics", async () => {
    const controlled = controlledProcess(41_001);
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(controlled),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");

    const result = await service.compact({ name: "reviewer" }, "compact-1");

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        type: "agent.compacted",
        agent: { id: expect.any(String), name: "reviewer" },
        compaction: { tokensBefore: 1200, estimatedTokensAfter: 300 },
      },
    });
    expect(controlled.compactCalls()).toBe(1);
    await service.close();
  });

  it("restores an absent idle agent before compaction", async () => {
    const first = controlledProcess(41_010);
    const restored = controlledProcess(41_011);
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: launcherFor(first, restored) });
    const created = await service.create(
      { name: "reviewer", cwd: "/tmp", piArgv: ["--session", "/tmp/reviewer.jsonl"] },
      "create-1",
    );
    expect(created).toMatchObject({ ok: true });
    first.exit();
    await vi.waitFor(async () => {
      expect(await store.getAgent("reviewer")).toMatchObject({
        summary: { state: "idle", process: { state: "absent" } },
      });
    });

    expect(await service.compact({ name: "reviewer" }, "compact-restored")).toMatchObject({
      ok: true,
      value: { type: "agent.compacted" },
    });
    expect(first.compactCalls()).toBe(0);
    expect(restored.compactCalls()).toBe(1);
    await service.close();
  });

  it("respects process capacity before restoring an absent agent", async () => {
    const target = controlledProcess(41_012);
    const blocker = controlledProcess(41_013);
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(target, blocker),
      limits: { maxResidentProcesses: 1 },
    });
    await service.create({ name: "target", cwd: "/tmp", piArgv: [] }, "create-target");
    await service.releaseAgentProcess("target");
    await service.create({ name: "blocker", cwd: "/tmp", piArgv: [] }, "create-blocker");

    expect(await service.compact({ name: "target" }, "compact-capacity")).toMatchObject({
      ok: false,
      error: { code: "capacity_exceeded" },
    });
    expect(target.compactCalls()).toBe(0);
    expect(blocker.compactCalls()).toBe(0);
    await service.close();
  });

  it("rejects authoritative active state without invoking native compaction", async () => {
    const controlled = controlledProcess(41_002);
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(controlled),
    });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    controlled.setState({ isStreaming: true });

    expect(await service.compact({ name: "reviewer" }, "compact-busy")).toMatchObject({
      ok: false,
      error: { code: "agent_busy" },
    });
    expect(controlled.compactCalls()).toBe(0);
    await service.close();
  });

  it("keeps receive waiting until compaction finishes", async () => {
    const controlled = controlledProcess(41_020);
    const gate = controlled.holdCompaction();
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(controlled),
    });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    const compact = service.compact({ name: "reviewer" }, "compact-held");
    await gate.started;

    let received = false;
    const receive = service.receive({ name: "reviewer" }).then((result) => {
      received = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toBe(false);

    gate.release();
    expect(await compact).toMatchObject({ ok: true });
    expect(await receive).toMatchObject({
      ok: true,
      value: { response: { text: "previous response" } },
    });
    await service.close();
  });

  it("persists destroy intent before stopping an active compaction", async () => {
    const controlled = controlledProcess(41_022);
    const compactGate = controlled.holdCompaction();
    const stopGate = controlled.holdStop();
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: launcherFor(controlled) });
    const created = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    if (!created.ok) throw new Error("create failed");
    const compact = service.compact({ name: "reviewer" }, "compact-held");
    await compactGate.started;

    const destroy = service.destroy({ name: "reviewer" }, "destroy-durable");
    await vi.waitFor(() => expect(controlled.stopCalls()).toBe(1));
    expect(await store.getOperation("destroy-durable")).toMatchObject({
      method: "destroy",
      state: "pending",
      targetAgent: { id: created.value.agent.id, name: "reviewer" },
    });
    stopGate.release();

    expect(await compact).toMatchObject({ ok: false, error: { code: "compaction_uncertain" } });
    expect(await destroy).toMatchObject({ ok: true });
    await service.close();
  });

  it("lets destroy stop a hanging compaction without waiting for its provider", async () => {
    const controlled = controlledProcess(41_021);
    const gate = controlled.holdCompaction();
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(controlled),
    });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    const compact = service.compact({ name: "reviewer" }, "compact-held");
    await gate.started;

    const destroy = service.destroy({ name: "reviewer" }, "destroy-during-compact");
    await vi.waitFor(() => expect(controlled.stopCalls()).toBe(1), { timeout: 100 });
    gate.release();

    expect(await compact).toMatchObject({ ok: false, error: { code: "compaction_uncertain" } });
    expect(await destroy).toMatchObject({ ok: true, value: { type: "agent.destroyed" } });
    await service.close();
  });

  it("does not overwrite completed compaction when operation-result persistence fails", async () => {
    const controlled = controlledProcess(41_023);
    const store = new OneShotCompactResultFailureStore();
    const service = new FleetService(store, { launcher: launcherFor(controlled) });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");

    expect(await service.compact({ name: "reviewer" }, "compact-store-failure")).toMatchObject({
      ok: true,
      value: { compaction: { tokensBefore: 1200, estimatedTokensAfter: 300 } },
    });
    expect(await store.getCompact("compact-store-failure")).toMatchObject({
      state: "completed",
      result: { tokensBefore: 1200, estimatedTokensAfter: 300 },
    });
    expect(controlled.stopCalls()).toBe(0);
    await service.close();
  });

  it("reconstructs a completed compact result after operation-result loss", async () => {
    const store = new MemoryFleetStore();
    const service = new FleetService(store);
    const created = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    if (!created.ok) throw new Error("create failed");
    await store.putOperation({
      operationId: "compact-recover",
      method: "compact",
      fingerprint: JSON.stringify({ name: "reviewer" }),
      state: "pending",
      result: null,
      targetAgent: { id: created.value.agent.id, name: "reviewer" },
    });
    await store.putCompact({
      compactId: "compact-recover",
      agentName: "reviewer",
      state: "completed",
      requestedAt: "2026-01-01T00:00:00.000Z",
      result: { tokensBefore: 900, estimatedTokensAfter: 250 },
    });

    expect(await service.compact({ name: "reviewer" }, "compact-recover")).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        type: "agent.compacted",
        agent: { id: created.value.agent.id, name: "reviewer" },
        compaction: { tokensBefore: 900, estimatedTokensAfter: 250 },
      },
    });
    await service.close();
  });

  it("does not apply a stale pending compact to a recreated agent with the same name", async () => {
    const controlled = controlledProcess(41_030);
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: launcherFor(controlled) });
    const first = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    if (!first.ok) throw new Error("create failed");
    await service.destroy({ name: "reviewer" }, "destroy-1");
    const replacement = controlledProcess(41_031);
    const replacementService = new FleetService(store, { launcher: launcherFor(replacement) });
    const second = await replacementService.create(
      { name: "reviewer", cwd: "/tmp", piArgv: [] },
      "create-2",
    );
    if (!second.ok) throw new Error("replacement create failed");
    await store.putOperation({
      operationId: "compact-stale",
      method: "compact",
      fingerprint: JSON.stringify({ name: "reviewer" }),
      state: "pending",
      result: null,
      targetAgent: { id: first.value.agent.id, name: "reviewer" },
    });
    await store.putCompact({
      compactId: "compact-stale",
      agentName: "reviewer",
      state: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await replacementService.compact({ name: "reviewer" }, "compact-stale")).toMatchObject({
      ok: false,
      error: { code: "agent_not_found" },
    });
    expect(replacement.compactCalls()).toBe(0);
    await replacementService.close();
  });

  it("stops Pi after an ambiguous compact failure and does not leave a live writer", async () => {
    const controlled = controlledProcess(41_040);
    controlled.rejectCompaction(new Error("PRIVATE_TRANSPORT_FAILURE"));
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: launcherFor(controlled) });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");

    expect(await service.compact({ name: "reviewer" }, "compact-uncertain")).toMatchObject({
      ok: false,
      error: {
        code: "compaction_uncertain",
        message: expect.not.stringContaining("PRIVATE_TRANSPORT_FAILURE"),
      },
    });
    expect(controlled.stopCalls()).toBe(1);
    await vi.waitFor(async () => {
      expect(await store.getAgent("reviewer")).toMatchObject({
        summary: {
          state: "failed",
          process: { state: "absent" },
          error: { code: "runtime_interrupted" },
        },
      });
    });
    await service.close();
  });

  it("reconciles a crash during dispatched compaction as interrupted without replay", async () => {
    const store = new MemoryFleetStore();
    const service = new FleetService(store);
    const created = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    if (!created.ok) throw new Error("create failed");
    await store.putOperation({
      operationId: "compact-crashed",
      method: "compact",
      fingerprint: JSON.stringify({ name: "reviewer" }),
      state: "pending",
      result: null,
      targetAgent: { id: created.value.agent.id, name: "reviewer" },
    });
    await store.putCompact({
      compactId: "compact-crashed",
      agentName: "reviewer",
      state: "dispatching",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.putIncarnation({
      incarnationId: "old-incarnation",
      agentName: "reviewer",
      pid: 999_999_999,
      state: "cleanup_uncertain",
    });
    const agent = await store.getAgent("reviewer");
    if (agent === null) throw new Error("missing agent");
    await store.putAgent({
      ...agent,
      summary: {
        ...agent.summary,
        state: "working",
        process: { state: "cleanup_uncertain" },
      },
    });

    await service.reconcile();

    expect(await store.getAgent("reviewer")).toMatchObject({
      summary: {
        state: "failed",
        process: { state: "absent" },
        error: { code: "runtime_interrupted" },
      },
    });
    expect(await store.getCompact("compact-crashed")).toMatchObject({ state: "uncertain" });
    expect(await store.getOperation("compact-crashed")).toMatchObject({
      state: "completed",
      result: { ok: false, error: { code: "compaction_uncertain" } },
    });
  });

  it("does not dispatch a send queued behind compaction after destroy begins", async () => {
    const controlled = controlledProcess(41_050);
    const gate = controlled.holdCompaction();
    const service = new FleetService(new MemoryFleetStore(), {
      launcher: launcherFor(controlled),
    });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    const compact = service.compact({ name: "reviewer" }, "compact-held");
    await gate.started;
    const send = service.send({ name: "reviewer", message: "must not run" }, "send-after-compact");
    const destroy = service.destroy({ name: "reviewer" }, "destroy-after-send");

    expect(await compact).toMatchObject({ ok: false, error: { code: "compaction_uncertain" } });
    expect(await send).toMatchObject({ ok: false, error: { code: "agent_destroying" } });
    expect(await destroy).toMatchObject({ ok: true });
    expect(controlled.promptCalls()).toBe(0);
    await service.close();
  });

  it.each([
    ["agent_busy", "Agent reviewer must be idle before compaction."],
    ["capacity_exceeded", "pi-fleet has reached its process limit."],
    ["pi_start_failed", "Pi failed to restore for reviewer; compaction was not dispatched."],
  ])("replays terminal %s compact failures after operation-result loss", async (code, message) => {
    const store = new MemoryFleetStore();
    const service = new FleetService(store);
    const created = await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");
    if (!created.ok) throw new Error("create failed");
    await store.putOperation({
      operationId: `compact-${code}`,
      method: "compact",
      fingerprint: JSON.stringify({ name: "reviewer" }),
      state: "pending",
      result: null,
      targetAgent: { id: created.value.agent.id, name: "reviewer" },
    });
    await store.putCompact({
      compactId: `compact-${code}`,
      agentName: "reviewer",
      state: "failed",
      requestedAt: "2026-01-01T00:00:00.000Z",
      error: { code, message },
    });

    expect(await service.compact({ name: "reviewer" }, `compact-${code}`)).toEqual({
      ok: false,
      error: { code, message },
    });
    await service.close();
  });

  it("maps native no-op and failure responses without exposing Pi error text", async () => {
    const nothing = controlledProcess(41_003);
    nothing.rejectCompaction(new PiCompactionError("nothing_to_compact"));
    const service = new FleetService(new MemoryFleetStore(), { launcher: launcherFor(nothing) });
    await service.create({ name: "reviewer", cwd: "/tmp", piArgv: [] }, "create-1");

    expect(await service.compact({ name: "reviewer" }, "compact-empty")).toMatchObject({
      ok: false,
      error: { code: "nothing_to_compact" },
    });
    await service.close();
  });
});
