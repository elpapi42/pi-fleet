import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import { segmentSemanticEvent } from "../../src/protocol/semantic-segmentation.js";
import { PROTOCOL_VERSION } from "../../src/protocol/version.js";
import type {
  ActivityId,
  AgentEventId,
  AgentId,
  ContinuityEpoch,
  ReceiveCursor,
  SemanticEvent,
} from "../../src/runtime/semantic-events.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(maxProtocolFrameBytes = 1_024) {
  const root = await mkdtemp(join(tmpdir(), "pifleet-protocol-fault-"));
  const socketPath = join(root, "control.sock");
  const service = new FleetService(new MemoryFleetStore());
  const server: ControlServer = await startControlServer({
    socketPath,
    service,
    limits: { maxProtocolFrameBytes },
  });
  cleanups.push(async () => {
    await server.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return socketPath;
}

async function exchange(socketPath: string, bytes: string): Promise<Record<string, unknown>> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.end(bytes);
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString().trim()) as Record<string, unknown>;
}

async function scriptedReceiveServer(
  frames: (requestId: string) => readonly Record<string, unknown>[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-protocol-scripted-"));
  const socketPath = join(root, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(Buffer.from(chunk).toString()) as { requestId: string };
      for (const frame of frames(request.requestId)) socket.write(`${JSON.stringify(frame)}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return socketPath;
}

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

describe("private protocol failure containment", () => {
  it("rejects malformed JSON without echoing the input", async () => {
    const socketPath = await harness();
    const canary = "PRIVATE_MALFORMED_CANARY";
    const response = await exchange(socketPath, `{not-json:${canary}}\n`);
    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "Malformed JSON protocol frame" },
    });
    expect(JSON.stringify(response)).not.toContain(canary);
  });

  it("rejects an oversized frame using a bounded generic error", async () => {
    const socketPath = await harness(128);
    const response = await exchange(socketPath, `${"x".repeat(129)}\n`);
    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "Protocol frame exceeds maximum size" },
    });
  });

  it("returns an actionable invalid_request for controlled schema failures", async () => {
    const socketPath = await harness();
    const response = await exchange(
      socketPath,
      `${JSON.stringify({ v: 999, requestId: "bad", method: "agent.list", params: {} })}\n`,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("rejects contradictory and non-boolean receive boundaries", async () => {
    const socketPath = await harness();
    for (const [requestId, params] of [
      ["contradictory", { name: "agent", expectedAgentId: "id", after: "cursor", fromStart: true }],
      ["bad-from-start", { name: "agent", expectedAgentId: "id", fromStart: "yes" }],
      ["bad-until-idle", { name: "agent", expectedAgentId: "id", untilIdle: "yes" }],
      [
        "after-until-idle",
        { name: "agent", expectedAgentId: "id", after: "cursor", untilIdle: true },
      ],
      [
        "from-start-until-idle",
        { name: "agent", expectedAgentId: "id", fromStart: true, untilIdle: true },
      ],
    ] as const) {
      const response = await exchange(
        socketPath,
        `${JSON.stringify({
          v: PROTOCOL_VERSION,
          requestId,
          method: "agent.receive",
          params,
        })}\n`,
      );
      expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("rejects a whole-event cursor discontinuity before emitting the event", async () => {
    const readyCursor = "cursor-a" as ReceiveCursor;
    const event: SemanticEvent = {
      type: "assistant.message.started",
      id: "event-c" as AgentEventId,
      activityId: "activity-c" as ActivityId,
      agentId: "agent-id" as AgentId,
      cursor: "cursor-c" as ReceiveCursor,
      epoch: 0 as ContinuityEpoch,
      sourceRawPosition: 1,
      observedAt: "2026-01-01T00:00:00Z",
    };
    const [segment] = segmentSemanticEvent(event, "cursor-b" as ReceiveCursor, 4_096);
    const socketPath = await scriptedReceiveServer((requestId) => [
      {
        v: PROTOCOL_VERSION,
        requestId,
        stream: "ready",
        cursor: readyCursor,
        limits: { maxEventBytes: 8_192, maxSegments: 32 },
      },
      { v: PROTOCOL_VERSION, requestId, stream: "semantic.segment", segment },
    ]);
    const client = new SocketFleetClient({ socketPath });
    const received = [];
    for await (const item of client.receive(
      { name: "agent", expectedAgentId: "agent-id" },
      { signal: new AbortController().signal },
    )) {
      received.push(item);
    }
    expect(received).toMatchObject([
      { ok: true, value: { type: "ready", cursor: readyCursor } },
      { ok: false, error: { code: "protocol_error" } },
    ]);
    expect(received.some((item) => item.ok && item.value.type === "event")).toBe(false);
  });

  it("does not answer or crash on an unterminated frame", async () => {
    const socketPath = await harness();
    const socket = await connect(socketPath);
    let received = false;
    socket.once("data", () => (received = true));
    socket.write('{"v":1');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(received).toBe(false);
    socket.destroy();

    const valid = await exchange(
      socketPath,
      `${JSON.stringify({ v: PROTOCOL_VERSION, requestId: "list", method: "agent.list", params: {} })}\n`,
    );
    expect(valid).toMatchObject({ ok: true, result: { type: "agent.list" } });
  });
});
