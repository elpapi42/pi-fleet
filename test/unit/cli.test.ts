import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { FleetClient } from "../../src/client/fleet-client.js";
import { createPiFleetClient, type PiFleetClient } from "../../src/client/sdk-facade.js";
import { FleetClientSdkTransport } from "../../src/client/sdk-transport.js";
import { unavailableFleetClient } from "../../src/client/unavailable-client.js";
import { runCli, type CliDependencies } from "../../src/entry/cli.js";
import { PRODUCT_VERSION } from "../../src/shared/product-identity.js";
import { ok } from "../../src/shared/result.js";

function createHarness() {
  let stdout = "";
  let stderr = "";
  const stream = (append: (chunk: string) => void) =>
    new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        append(chunk.toString());
        callback();
      },
    });
  const dependencies: CliDependencies = {
    client: sdkClient(unavailableFleetClient),
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout: stream((chunk) => (stdout += chunk)),
    stderr: stream((chunk) => (stderr += chunk)),
    signal: new AbortController().signal,
  };
  return { dependencies, read: () => ({ stderr, stdout }) };
}

function sdkClient(client: FleetClient): PiFleetClient {
  return createPiFleetClient(
    new FleetClientSdkTransport(
      client,
      () => ({ operationId: "operation-1", createdAt: "2026-01-01T00:00:00.000Z" }),
      { reconnectDelayMs: 0 },
    ),
  );
}

describe("runCli", () => {
  it("prints the package version", async () => {
    const harness = createHarness();

    expect(await runCli(["--version"], harness.dependencies)).toBe(0);
    expect(harness.read()).toEqual({ stderr: "", stdout: `${PRODUCT_VERSION}\n` });
  });

  it("reports unavailable runtime without pretending the command works", async () => {
    const harness = createHarness();

    expect(await runCli(["list"], harness.dependencies)).toBe(1);
    expect(harness.read().stdout).toBe("");
    expect(JSON.parse(harness.read().stderr)).toMatchObject({
      type: "error",
      error: { code: "runtime_unavailable" },
    });
  });

  it("treats a closed receive output pipe as normal client disconnection", async () => {
    const harness = createHarness();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stdout = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    const client: FleetClient = {
      ...unavailableFleetClient,
      status: async () =>
        ok({
          schemaVersion: 1,
          type: "agent.status",
          agent: {
            id: "agent-1",
            name: "agent",
            state: "idle",
            process: { state: "absent" },
            session: { id: null, path: null },
          },
        }),
      receive: async function* () {
        yield ok({ type: "ready", cursor: "cursor-0" as never });
        yield ok({
          type: "event",
          cursor: "cursor-1" as never,
          event: {
            id: "event-1",
            activityId: "activity-1",
            cursor: "cursor-1",
            agentId: "agent-1",
            epoch: 0,
            sourceRawPosition: 1,
            observedAt: "2026-01-01T00:00:00.000Z",
            type: "assistant.message.started",
          } as never,
        });
      },
    };

    expect(
      await runCli(["receive", "agent"], {
        ...harness.dependencies,
        client: sdkClient(client),
        stdout,
      }),
    ).toBe(0);
    expect(harness.read().stderr).toBe(
      `${JSON.stringify({ schemaVersion: 1, type: "receive.ready", cursor: "cursor-0" })}\n`,
    );
  });
});
