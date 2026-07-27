import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import { createLaunchProfile, observeSession } from "../../src/pi/launch-profile.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import type { StoredAgent } from "../../src/store/fleet-store.js";
import { JournalFleetStoreAdapter } from "../../src/store/journal-fleet-store-adapter.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

function countingLauncher() {
  let starts = 0;
  let prompts = 0;
  const launcher: PiLauncher = {
    artifactId: "counting-pi",
    async start() {
      starts += 1;
      let exitListener: ((error: Error | null) => void) | undefined;
      return {
        pid: 43_000 + starts,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: "/tmp/delivery-session.jsonl",
            sessionId: "delivery-session",
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

function absentAgent(name: string): StoredAgent {
  const profile = createLaunchProfile({
    cwd: "/tmp",
    piArgv: ["--session", "/tmp/delivery-session.jsonl"],
  });
  return {
    summary: {
      id: `${name}-id`,
      name,
      state: "idle",
      process: { state: "absent" },
      session: { path: "/tmp/delivery-session.jsonl", id: "delivery-session" },
    },
    launch: observeSession(profile, {
      path: "/tmp/delivery-session.jsonl",
      id: "delivery-session",
    }),
  };
}

describe("durable delivery recovery", () => {
  it("dispatches a proven-unwritten pending send once", async () => {
    const store = new MemoryFleetStore();
    await store.createAgent(absentAgent("pending"));
    await store.putSend({
      sendId: "pending-send",
      agentId: "pending-id",
      agentName: "pending",
      ordinal: 1,
      message: "once",
      delivery: "steer",
      state: "pending",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    });
    const counter = countingLauncher();
    const service = new FleetService(store, { launcher: counter.launcher });

    await service.reconcile();

    expect(counter.starts()).toBe(1);
    expect(counter.prompts()).toBe(1);
    expect(await store.getSend("pending-send")).toMatchObject({ state: "acknowledged" });
    await service.close();
  });

  it("canonicalizes omitted delivery before journal persistence and recovery", async () => {
    const journal = new MemoryJournalStore();
    const store = new JournalFleetStoreAdapter(journal);
    const counter = countingLauncher();
    const first = new FleetService(store, { launcher: counter.launcher });
    await first.create({ name: "canonical", cwd: "/tmp", piArgv: [] }, "create-canonical");
    await first.send({ name: "canonical", message: "default steering" }, "send-canonical");

    const operation = await journal.getOperation("send-canonical");
    const send = await journal.getSend("send-canonical");
    expect(operation?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(operation?.fingerprint).not.toContain("default steering");
    expect(send).toMatchObject({ delivery: "steer", state: "acknowledged" });
    if (operation === null || send === null) throw new Error("Expected durable send state");

    await journal.putOperation({ ...operation, state: "pending", result: null });
    await journal.putSend({ ...send, state: "pending" });
    await first.close();

    const recovered = new FleetService(store, { launcher: counter.launcher });
    await recovered.reconcile();
    expect(await journal.getOperation("send-canonical")).toMatchObject({
      state: "completed",
      result: { ok: true },
    });
    expect(await journal.getSend("send-canonical")).toMatchObject({ state: "acknowledged" });
    await recovered.close();
  });

  it("marks a possibly-written dispatching send uncertain without replay", async () => {
    const store = new MemoryFleetStore();
    await store.createAgent(absentAgent("dispatching"));
    await store.putSend({
      sendId: "dispatching-send",
      agentId: "dispatching-id",
      agentName: "dispatching",
      ordinal: 1,
      message: "never replay",
      delivery: "steer",
      state: "dispatching",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    });
    const counter = countingLauncher();
    const service = new FleetService(store, { launcher: counter.launcher });

    await service.reconcile();

    expect(counter.starts()).toBe(0);
    expect(counter.prompts()).toBe(0);
    expect(await store.getSend("dispatching-send")).toMatchObject({ state: "uncertain" });
    await service.close();
  });

  it("replays a committed operation result without dispatching its message again", async () => {
    const store = new MemoryFleetStore();
    const counter = countingLauncher();
    const first = new FleetService(store, { launcher: counter.launcher });
    await first.create({ name: "committed", cwd: "/tmp", piArgv: [] }, "create-committed");
    const original = await first.send(
      { name: "committed", message: "one side effect" },
      "send-committed",
    );
    await first.close();
    const startsBeforeRetry = counter.starts();
    const promptsBeforeRetry = counter.prompts();
    const recovered = new FleetService(store, { launcher: counter.launcher });

    const retry = await recovered.send(
      { name: "committed", message: "one side effect" },
      "send-committed",
    );

    expect(retry).toEqual(original);
    expect(counter.starts()).toBe(startsBeforeRetry);
    expect(counter.prompts()).toBe(promptsBeforeRetry);
    await recovered.close();
  });
});
