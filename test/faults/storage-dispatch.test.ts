import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import type { StoredSend } from "../../src/store/fleet-store.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

class FailingSendStore extends MemoryFleetStore {
  constructor(
    private readonly failState: StoredSend["state"],
    private remainingFailures = Number.POSITIVE_INFINITY,
  ) {
    super();
  }

  override async putSend(send: StoredSend): Promise<void> {
    if (send.state === this.failState && this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("PRIVATE_STORAGE_FAILURE_CANARY");
    }
    await super.putSend(send);
  }
}

function countingLauncher() {
  let prompts = 0;
  const launcher: PiLauncher = {
    artifactId: "storage-fault-pi",
    async start() {
      let exitListener: ((error: Error | null) => void) | undefined;
      return {
        pid: 44_000,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: "/tmp/storage-fault.jsonl",
            sessionId: "storage-fault",
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
  return { launcher, prompts: () => prompts };
}

describe("fail-closed dispatch on storage errors", () => {
  it("does not write to Pi when pending delivery cannot be persisted", async () => {
    const store = new FailingSendStore("pending");
    const pi = countingLauncher();
    const service = new FleetService(store, { launcher: pi.launcher });
    await service.create({ name: "agent", cwd: "/tmp", piArgv: [] }, "create-agent");

    await expect(
      service.send({ name: "agent", message: "must persist" }, "send-agent"),
    ).rejects.toThrow("PRIVATE_STORAGE_FAILURE_CANARY");
    expect(pi.prompts()).toBe(0);
    await service.close();
  });

  it("safely retries the same operation when no send record could be persisted", async () => {
    const store = new FailingSendStore("pending", 1);
    const pi = countingLauncher();
    const service = new FleetService(store, { launcher: pi.launcher });
    await service.create({ name: "agent", cwd: "/tmp", piArgv: [] }, "create-agent");

    await expect(
      service.send({ name: "agent", message: "retry safely" }, "send-agent"),
    ).rejects.toThrow("PRIVATE_STORAGE_FAILURE_CANARY");
    await expect(
      service.send({ name: "agent", message: "retry safely" }, "send-agent"),
    ).resolves.toMatchObject({ ok: true });
    expect(pi.prompts()).toBe(1);
    await service.close();
  });

  it("marks delivery uncertain without replay when acknowledgement persistence fails", async () => {
    const store = new FailingSendStore("acknowledged");
    const pi = countingLauncher();
    const service = new FleetService(store, { launcher: pi.launcher });
    await service.create({ name: "agent", cwd: "/tmp", piArgv: [] }, "create-agent");

    const result = await service.send({ name: "agent", message: "one write" }, "send-agent");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "delivery_uncertain",
        message: "Pi may have accepted the message; Fleet will not replay it automatically.",
      },
    });
    expect(pi.prompts()).toBe(1);
    expect(await store.getSend("send-agent")).toMatchObject({ state: "uncertain" });
    await service.close();
  });
});
