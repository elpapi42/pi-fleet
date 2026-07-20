import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { unavailableFleetClient } from "../../src/client/unavailable-client.js";
import { runCli, type CliDependencies } from "../../src/entry/cli.js";

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
    expect(harness.read()).toEqual({ stderr: "", stdout: "0.1.0-beta.0\n" });
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
});
