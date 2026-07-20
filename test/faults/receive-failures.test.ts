import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

interface ControlledPi {
  readonly launcher: PiLauncher;
  settle(text: string): void;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function controlledPi(stateDelayMs = 0): ControlledPi {
  let streaming = false;
  let latest: string | null = null;
  let frameListener: ((frame: { type: string }) => void) | undefined;
  let exitListener: ((error: Error | null) => void) | undefined;
  return {
    launcher: {
      artifactId: "controlled-pi",
      async start() {
        return {
          pid: 41_000,
          async getState() {
            if (stateDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, stateDelayMs));
            }
            return {
              isStreaming: streaming,
              isCompacting: false,
              pendingMessageCount: 0,
              sessionFile: "/tmp/controlled-receive.jsonl",
              sessionId: "controlled-receive",
            };
          },
          async prompt() {
            streaming = true;
            frameListener?.({ type: "agent_start" });
          },
          async getLastAssistantText() {
            return latest;
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
    },
    settle(text: string) {
      latest = text;
      streaming = false;
      frameListener?.({ type: "agent_settled" });
    },
  };
}

async function harness(
  options: { readonly working?: boolean; readonly stateDelayMs?: number } = { working: true },
) {
  const root = await mkdtemp(join(tmpdir(), "pifleet-receive-fault-"));
  const socketPath = join(root, "control.sock");
  const pi = controlledPi(options.stateDelayMs);
  const store = new MemoryFleetStore();
  const service = new FleetService(store, {
    launcher: pi.launcher,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const server: ControlServer = await startControlServer({ socketPath, service });
  cleanups.push(async () => {
    await server.close();
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const client = new SocketFleetClient({ socketPath });
  const signal = new AbortController().signal;
  await client.create(
    { name: "agent", cwd: root, piArgv: [] },
    {
      signal,
      operation: { operationId: "create-agent", createdAt: "2026-01-01T00:00:00.000Z" },
    },
  );
  if (options.working !== false) {
    await client.send(
      { name: "agent", message: "work" },
      {
        signal,
        operation: { operationId: "send-work", createdAt: "2026-01-01T00:00:00.000Z" },
      },
    );
  }
  return { client, pi, service, signal, store };
}

function requestOptions(signal: AbortSignal, timeoutMs?: number) {
  return { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

describe("receive timeout and cancellation", () => {
  it("polls an already-idle agent without crashing the control server", async () => {
    const { client, signal } = await harness({ working: false, stateDelayMs: 5 });

    await expect(client.receive({ name: "agent" }, requestOptions(signal, 0))).resolves.toEqual({
      ok: false,
      error: { code: "no_response", message: "Agent agent has no assistant response." },
    });
    await expect(client.list(requestOptions(signal))).resolves.toMatchObject({
      ok: true,
      value: { type: "agent.list" },
    });
  });

  it("returns a settled response repeatedly with an immediate poll", async () => {
    const { client, pi, signal } = await harness();
    pi.settle("repeatable response");

    await expect(
      client.receive({ name: "agent" }, requestOptions(signal, 0)),
    ).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "repeatable response" } },
    });
    await expect(
      client.receive({ name: "agent" }, requestOptions(signal, 0)),
    ).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "repeatable response" } },
    });
  });

  it("returns interruption instead of a stale response after active work fails", async () => {
    const { client, pi, service, signal, store } = await harness();
    pi.settle("previous response");
    await expect(client.receive({ name: "agent" }, requestOptions(signal))).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "previous response" } },
    });

    await service.close();
    const agent = await store.getAgent("agent");
    expect(agent).not.toBeNull();
    await store.putAgent({
      ...agent!,
      summary: {
        ...agent!.summary,
        state: "failed",
        process: { state: "absent" },
        error: { code: "runtime_interrupted" },
      },
    });

    await expect(client.receive({ name: "agent" }, requestOptions(signal, 0))).resolves.toEqual({
      ok: false,
      error: {
        code: "runtime_interrupted",
        message:
          "Agent agent is failed (runtime_interrupted) and has no current successful response.",
      },
    });
  });

  it("times out only the caller and allows a later receive to return the settled response", async () => {
    const { client, pi, signal } = await harness();

    await expect(client.receive({ name: "agent" }, requestOptions(signal, 0))).resolves.toEqual({
      ok: false,
      error: { code: "timeout", message: "Agent did not become idle before timeout." },
    });

    pi.settle("completed after timeout");
    await expect(client.receive({ name: "agent" }, requestOptions(signal))).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "completed after timeout" } },
    });
  });

  it("lets one receiver time out without removing another receiver", async () => {
    const { client, pi, signal } = await harness();
    const waiting = client.receive({ name: "agent" }, requestOptions(signal, 2_000));
    const timedOut = client.receive({ name: "agent" }, requestOptions(signal, 5));

    await expect(timedOut).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
    pi.settle("other receiver remains");
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "other receiver remains" } },
    });
  });

  it("cancels one disconnected receiver without changing Pi or another receiver", async () => {
    const { client, pi } = await harness();
    const disconnected = new AbortController();
    const waitingSignal = new AbortController();
    const cancelled = client.receive({ name: "agent" }, requestOptions(disconnected.signal, 2_000));
    const waiting = client.receive({ name: "agent" }, requestOptions(waitingSignal.signal, 2_000));
    disconnected.abort();
    await expect(cancelled).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });

    pi.settle("survived disconnect");
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: { response: { text: "survived disconnect" } },
    });
  });

  it("resolves a held receiver with agent_destroyed when destroy wins", async () => {
    const { client, signal } = await harness();
    const receiving = client.receive({ name: "agent" }, requestOptions(signal, 2_000));
    await client.destroy(
      { name: "agent" },
      {
        signal,
        operation: { operationId: "destroy-agent", createdAt: "2026-01-01T00:00:00.000Z" },
      },
    );
    await expect(receiving).resolves.toEqual({
      ok: false,
      error: { code: "agent_destroyed", message: "Agent agent was destroyed." },
    });
  });
});
