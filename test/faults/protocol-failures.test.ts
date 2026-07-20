import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
      `${JSON.stringify({ v: 1, requestId: "list", method: "agent.list", params: {} })}\n`,
    );
    expect(valid).toMatchObject({ ok: true, result: { type: "agent.list" } });
  });
});
