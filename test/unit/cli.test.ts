import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

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
    client: unavailableFleetClient,
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout: stream((chunk) => (stdout += chunk)),
    stderr: stream((chunk) => (stderr += chunk)),
    signal: new AbortController().signal,
    operationIds: () => ({ operationId: "operation-1", createdAt: "2026-01-01T00:00:00.000Z" }),
  };
  return { dependencies, read: () => ({ stderr, stdout }) };
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

  it("treats a closed watch output pipe as normal client disconnection", async () => {
    const harness = createHarness();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stdout = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    const client = {
      ...unavailableFleetClient,
      watchSession: async function* () {
        yield ok({ bytes: Buffer.from('{"type":"message"}\n') });
      },
    };

    expect(await runCli(["watch", "agent"], { ...harness.dependencies, client, stdout })).toBe(0);
    expect(harness.read().stderr).toBe("");
  });
});
