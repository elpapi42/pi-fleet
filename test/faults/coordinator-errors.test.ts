import { describe, expect, it } from "vitest";

import type { PiProcess } from "../../src/pi/process.js";
import { AgentCoordinator } from "../../src/runtime/agent-coordinator.js";
import type { StoredAgent } from "../../src/store/fleet-store.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

class EventFailingStore extends MemoryFleetStore {
  failEvents = false;

  override async putAgent(agent: StoredAgent): Promise<void> {
    if (this.failEvents) throw new Error("PRIVATE_EVENT_STORE_CANARY");
    await super.putAgent(agent);
  }
}

describe("coordinator event failure containment", () => {
  it("stops Pi and reports a coordinator failure instead of creating an unhandled rejection", async () => {
    const store = new EventFailingStore();
    const agent: StoredAgent = {
      summary: {
        id: "agent-id",
        name: "agent",
        state: "idle",
        process: { state: "resident" },
        session: { path: "/tmp/session.jsonl", id: "session" },
      },
      launch: {
        cwd: "/tmp",
        userPiArgv: ["--session", "/tmp/session.jsonl"],
        selector: { kind: "session", value: "/tmp/session.jsonl" },
        observedSession: { path: "/tmp/session.jsonl", id: "session" },
        restorePiArgv: ["--session", "/tmp/session.jsonl"],
        piArtifactId: "fake-pi",
      },
      latestAssistantText: null,
      responseObservedAt: null,
    };
    await store.createAgent(agent);
    let frameListener: ((frame: { type: string }) => void) | undefined;
    let exitListener: ((error: Error | null) => void) | undefined;
    let stopped = false;
    const process = {
      pid: 45_000,
      async getState() {
        return {
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
          sessionFile: "/tmp/session.jsonl",
          sessionId: "session",
        };
      },
      async prompt() {},
      async getLastAssistantText() {
        return null;
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
        stopped = true;
      },
    } as unknown as PiProcess;
    void exitListener;
    let reportFailure!: (error: Error | null) => void;
    const failed = new Promise<Error | null>((resolve) => (reportFailure = resolve));
    new AgentCoordinator(
      store,
      agent,
      process,
      "incarnation",
      () => "2026-01-01T00:00:00.000Z",
      reportFailure,
    );
    store.failEvents = true;

    frameListener?.({ type: "agent_start" });

    await expect(failed).resolves.toMatchObject({ message: "PRIVATE_EVENT_STORE_CANARY" });
    expect(stopped).toBe(true);
  });
});
