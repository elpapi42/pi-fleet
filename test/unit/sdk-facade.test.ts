import { describe, expect, it } from "vitest";

import {
  createConnectPiFleet,
  PiFleetError,
  type SdkTransport,
} from "../../src/client/sdk-facade.js";
import type { ExpectedAgentTarget } from "../../src/client/agent-target.js";
import type { AgentSummary, ReceiveCursor, ReceiveStream } from "../../src/client/contracts.js";

const summary: AgentSummary = {
  id: "agent-1",
  name: "reviewer",
  state: "idle",
  process: { state: "absent" },
  session: { id: null, path: null },
};

function emptyStream(): ReceiveStream {
  return {
    cursor: "cursor-0" as ReceiveCursor,
    async *[Symbol.asyncIterator]() {
      // Intentionally empty dormant transport fixture.
    },
  };
}

describe("dormant SDK facade", () => {
  it("is inert until explicit connection and binds Agent calls to the immutable id", async () => {
    let connections = 0;
    let target: ExpectedAgentTarget | undefined;
    let createInput: unknown;
    const receiveStarts: unknown[] = [];
    const transport: SdkTransport = {
      async create(input) {
        createInput = input;
        return summary;
      },
      async get() {
        return summary;
      },
      async list() {
        return [summary];
      },
      async status(input) {
        target = input;
        return summary;
      },
      async send(input) {
        target = input;
        return { acceptedAt: "2026-01-01T00:00:00.000Z" };
      },
      async receive(input, start) {
        target = input;
        receiveStarts.push(start);
        return emptyStream();
      },
      async compact(input) {
        target = input;
        return { tokensBefore: 100 };
      },
      async destroy(input) {
        target = input;
      },
      async close() {},
    };
    const connectPiFleet = createConnectPiFleet({
      async connect() {
        connections += 1;
        return transport;
      },
    });
    expect(connections).toBe(0);

    const client = await connectPiFleet({ autoStartRuntime: false });
    expect(connections).toBe(1);
    const created = await client.create({
      name: "reviewer",
      cwd: "/repo",
      piArgs: ["--session", "/tmp/reviewer.jsonl"],
    });
    expect(created.id).toBe("agent-1");
    expect(createInput).toEqual({
      name: "reviewer",
      cwd: "/repo",
      piArgs: ["--session", "/tmp/reviewer.jsonl"],
    });
    const agent = await client.get("reviewer");
    expect(agent).not.toBeNull();
    await agent!.send("hello", { delivery: "followUp" });
    expect(target).toEqual({ name: "reviewer", expectedAgentId: "agent-1" });
    const stream = await agent!.receive();
    expect(stream.cursor).toBe("cursor-0");
    await agent!.receive({ after: "cursor-after" as ReceiveCursor });
    await agent!.receive({ fromStart: true });
    expect(receiveStarts).toEqual([
      { kind: "live" },
      { kind: "after", cursor: "cursor-after" },
      { kind: "start" },
    ]);
  });

  it("closing a client closes only its transport and later handle calls fail locally", async () => {
    let closes = 0;
    const transport = {
      async get() {
        return summary;
      },
      async close() {
        closes += 1;
      },
    } as unknown as SdkTransport;
    const client = await createConnectPiFleet({
      async connect() {
        return transport;
      },
    })();
    const agent = await client.get("reviewer");
    await client.close();
    await client.close();
    expect(closes).toBe(1);
    await expect(agent!.status()).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("client close aborts active local operation signals without touching agents", async () => {
    let receiveSignal: AbortSignal | undefined;
    const transport = {
      async get() {
        return summary;
      },
      async receive(_target: ExpectedAgentTarget, _start: unknown, signal: AbortSignal) {
        receiveSignal = signal;
        return emptyStream();
      },
      async close() {},
    } as unknown as SdkTransport;
    const client = await createConnectPiFleet({
      async connect() {
        return transport;
      },
    })();
    const agent = await client.get("reviewer");
    await agent.receive();
    expect(receiveSignal?.aborted).toBe(false);

    await client.close();
    expect(receiveSignal?.aborted).toBe(true);
  });

  it("redacts unknown transport failures behind one stable error class", async () => {
    const transport = {
      async list() {
        throw new Error("provider secret");
      },
      async close() {},
    } as unknown as SdkTransport;
    const client = await createConnectPiFleet({
      async connect() {
        return transport;
      },
    })();
    await expect(client.list()).rejects.toEqual(
      new PiFleetError("internal_error", "pi-fleet client operation failed"),
    );
  });
});
