import { describe, expect, it } from "vitest";

import { PiExecutionUnavailableError, type PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import type { PiRuntimeIdentity } from "../../src/protocol/pi-identity.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

function controlledLauncher() {
  let available = true;
  let pid = 50_000;
  let starts = 0;
  let prompts = 0;
  let compactions = 0;
  const launcher: PiLauncher = {
    artifactId: "controlled-pi",
    async preflight() {
      if (!available) throw new PiExecutionUnavailableError("pi_not_found");
    },
    async start(): Promise<PiProcess> {
      starts += 1;
      let exitListener: ((error: Error | null) => void) | undefined;
      const currentPid = pid++;
      return {
        pid: currentPid,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: `/tmp/pi-execution-${String(currentPid)}.jsonl`,
            sessionId: `pi-execution-${String(currentPid)}`,
          };
        },
        async prompt() {
          prompts += 1;
        },
        async compact() {
          compactions += 1;
          return { tokensBefore: 100, estimatedTokensAfter: 50 };
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
  return {
    launcher,
    setAvailable(value: boolean) {
      available = value;
    },
    counts: () => ({ starts, prompts, compactions }),
  };
}

describe("Pi execution availability", () => {
  it("fails new work before dispatch while passive commands and destroy remain available", async () => {
    const controlled = controlledLauncher();
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: controlled.launcher });
    const created = await service.create(
      { name: "resident", cwd: "/tmp", piArgv: [] },
      "create-resident",
    );
    expect(created).toMatchObject({ ok: true });
    await service.releaseAgentProcess("resident");
    const stored = await store.getAgent("resident");
    if (stored === null) throw new Error("missing resident agent");
    await store.putAgent({
      ...stored,
      latestAssistantText: "stored response",
      responseObservedAt: "2026-01-01T00:00:00.000Z",
    });
    controlled.setAvailable(false);

    const rejectedCreate = await service.create(
      { name: "new-agent", cwd: "/tmp", piArgv: [] },
      "create-unavailable",
    );
    const rejectedSend = await service.send(
      { name: "resident", message: "must not dispatch" },
      "send-unavailable",
    );
    const rejectedCompact = await service.compact({ name: "resident" }, "compact-unavailable");

    expect(rejectedCreate).toMatchObject({ ok: false, error: { code: "pi_not_found" } });
    expect(rejectedSend).toEqual(rejectedCreate);
    expect(rejectedCompact).toEqual(rejectedCreate);
    expect(await store.getAgent("new-agent")).toBeNull();
    expect(await store.getSend("send-unavailable")).toBeNull();
    expect(await store.getCompact("compact-unavailable")).toMatchObject({
      state: "failed",
      error: { code: "pi_not_found" },
    });
    expect(controlled.counts()).toEqual({ starts: 1, prompts: 0, compactions: 0 });

    expect(await service.status({ name: "resident" })).toMatchObject({ ok: true });
    expect(await service.list()).toMatchObject({
      ok: true,
      value: { agents: [{ name: "resident" }] },
    });
    expect(await service.receive({ name: "resident" })).toMatchObject({
      ok: true,
      value: { response: { text: "stored response" } },
    });
    const abort = new AbortController();
    expect(await service.openWatch({ name: "resident" }, abort.signal)).toMatchObject({ ok: true });
    abort.abort();
    expect(await service.destroy({ name: "resident" }, "destroy-resident")).toMatchObject({
      ok: true,
    });
    await service.close();
  });

  it("rejects a mismatched Pi identity before prompting a resident agent", async () => {
    const controlled = controlledLauncher();
    const store = new MemoryFleetStore();
    const service = new FleetService(store, { launcher: controlled.launcher });
    await service.create({ name: "resident", cwd: "/tmp", piArgv: [] }, "create-resident");
    const mismatched: PiRuntimeIdentity = {
      mode: "external",
      selectedPath: "/tmp/pi",
      nodePath: "/tmp/node",
      realPath: "/tmp/pi-target",
      version: "0.82.1",
      fingerprint: "different",
    };

    const result = await service.send(
      { name: "resident", message: "must not prompt" },
      "send-mismatch",
      mismatched,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "pi_runtime_mismatch" } });
    expect(controlled.counts()).toEqual({ starts: 1, prompts: 0, compactions: 0 });
    expect(await store.getSend("send-mismatch")).toBeNull();
    expect(await store.getOperation("send-mismatch")).toMatchObject({
      state: "completed",
      result,
    });
    await service.close();
  });

  it("replays completed results even after Pi becomes unavailable", async () => {
    const controlled = controlledLauncher();
    const service = new FleetService(new MemoryFleetStore(), { launcher: controlled.launcher });
    const input = { name: "resident", cwd: "/tmp", piArgv: [] } as const;
    const first = await service.create(input, "stable-operation");
    expect(first).toMatchObject({ ok: true });
    controlled.setAvailable(false);

    expect(await service.create(input, "stable-operation")).toEqual(first);
    expect(controlled.counts().starts).toBe(1);
    await service.close();
  });

  it("reconciles certainty and destroy while leaving proven-undispatched work pending", async () => {
    const controlled = controlledLauncher();
    const store = new MemoryFleetStore();
    const first = new FleetService(store, { launcher: controlled.launcher });
    for (const name of ["send-agent", "compact-agent", "destroy-agent"]) {
      expect(await first.create({ name, cwd: "/tmp", piArgv: [] }, `create-${name}`)).toMatchObject(
        {
          ok: true,
        },
      );
    }
    await first.close();

    const sendInput = { name: "send-agent", message: "pending" };
    await store.putOperation({
      operationId: "pending-send",
      method: "send",
      fingerprint: JSON.stringify(sendInput),
      state: "pending",
      result: null,
    });
    await store.putSend({
      sendId: "pending-send",
      agentName: "send-agent",
      ordinal: 1,
      message: "pending",
      state: "pending",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    });
    const compactInput = { name: "compact-agent" };
    await store.putOperation({
      operationId: "pending-compact",
      method: "compact",
      fingerprint: JSON.stringify(compactInput),
      state: "pending",
      result: null,
    });
    await store.putCompact({
      compactId: "pending-compact",
      agentName: "compact-agent",
      state: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    const createInput = { name: "create-agent", cwd: "/tmp", piArgv: [] };
    await store.putOperation({
      operationId: "pending-create",
      method: "create",
      fingerprint: JSON.stringify(createInput),
      state: "pending",
      result: null,
    });
    const destroyInput = { name: "destroy-agent" };
    await store.putOperation({
      operationId: "pending-destroy",
      method: "destroy",
      fingerprint: JSON.stringify(destroyInput),
      state: "pending",
      result: null,
    });

    controlled.setAvailable(false);
    const startsBefore = controlled.counts().starts;
    const second = new FleetService(store, { launcher: controlled.launcher });
    await second.reconcile();

    expect(await store.getSend("pending-send")).toMatchObject({ state: "pending" });
    expect(await store.getCompact("pending-compact")).toMatchObject({ state: "pending" });
    expect(await store.getOperation("pending-create")).toMatchObject({ state: "pending" });
    expect(await store.getAgent("create-agent")).toBeNull();
    expect(await store.getAgent("destroy-agent")).toBeNull();
    expect(controlled.counts()).toEqual({
      starts: startsBefore,
      prompts: 0,
      compactions: 0,
    });
    await second.close();
  });
});
