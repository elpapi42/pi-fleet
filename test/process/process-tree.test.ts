import { once } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { isProcessAlive, signalProcessTree } from "../../src/platform/runtime/process-tree.js";

describe.skipIf(process.platform === "win32")("process-group cleanup", () => {
  it("escalates a dedicated process group that ignores SIGTERM", async () => {
    const processTree = spawn(process.execPath, ["test/fixtures/stubborn-tree.mjs"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    processTree.stdout.setEncoding("utf8");
    const [chunk] = (await once(processTree.stdout, "data")) as [string];
    const pids = JSON.parse(chunk) as { parent: number; child: number };

    signalProcessTree(pids.parent, "SIGTERM");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect(isProcessAlive(pids.parent)).toBe(true);

    signalProcessTree(pids.parent, "SIGKILL");
    await once(processTree, "exit");
    expect(isProcessAlive(pids.parent)).toBe(false);
  });
});
