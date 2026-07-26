import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLaunchProfile } from "../../src/pi/launch-profile.js";
import { createExternalPiTarget } from "../../src/pi/external-target.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pifleet-external-target-"));
  cleanups.push(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function piExecutable(path: string, version = "0.82.1"): Promise<void> {
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o700);
}

async function nodeAwarePi(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write(process.env.PIFLEET_SELECTED_NODE === "1" ? "0.82.1\\n" : "wrong-node\\n");
  process.exit(0);
}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "get_state" || process.env.PIFLEET_SELECTED_NODE !== "1") process.exit(19);
  process.stdout.write(JSON.stringify({
    id: request.id,
    type: "response",
    command: "get_state",
    success: true,
    data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: null, sessionId: "shim" },
  }) + "\\n");
});
`,
  );
  await chmod(path, 0o700);
}

async function selectedNodeShim(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nexport PIFLEET_SELECTED_NODE=1\nexec "${process.execPath}" "$@"\n`,
  );
  await chmod(path, 0o700);
}

describe("external Pi runtime target", () => {
  it("observes the configured Pi independently and detects later replacement", async () => {
    const directory = await root();
    const selected = join(directory, "pi");
    await piExecutable(selected);
    const target = await createExternalPiTarget({
      PATH: process.env.PATH,
      PIFLEET_PI_EXECUTABLE: selected,
      PIFLEET_PI_NODE: process.execPath,
    });

    expect(target.identity).toMatchObject({
      mode: "external",
      selectedPath: selected,
      version: "0.82.1",
    });
    await expect(target.launcher.preflight?.()).resolves.toBeUndefined();

    await piExecutable(selected, "0.82.2");
    await expect(target.launcher.preflight?.()).rejects.toMatchObject({
      code: "pi_installation_changed",
    });
  });

  it("uses the selected Node for external Pi observation and spawning", async () => {
    const directory = await root();
    const bin = join(directory, "selected-node-bin");
    await mkdir(bin);
    const selectedNode = join(bin, "node");
    const selectedPi = join(directory, "pi script");
    await selectedNodeShim(selectedNode);
    await nodeAwarePi(selectedPi);

    const target = await createExternalPiTarget({
      PATH: "/usr/bin:/bin",
      PIFLEET_PI_EXECUTABLE: selectedPi,
      PIFLEET_PI_NODE: selectedNode,
    });
    expect(target.identity).toMatchObject({
      mode: "external",
      selectedPath: selectedPi,
      nodePath: selectedNode,
      version: "0.82.1",
    });

    const process = await target.launcher.start(
      createLaunchProfile({ cwd: directory, piArgv: [] }),
      false,
    );
    await expect(process.getState()).resolves.toMatchObject({ sessionId: "shim" });
    await process.stop();
  });

  it("keeps the control target constructible when configured Pi is missing", async () => {
    const selected = join(await root(), "missing-pi");
    const target = await createExternalPiTarget({
      PATH: process.env.PATH,
      PIFLEET_PI_EXECUTABLE: selected,
      PIFLEET_PI_NODE: process.execPath,
    });

    expect(target.identity).toMatchObject({ mode: "external", selectedPath: selected });
    await expect(target.launcher.preflight?.()).rejects.toMatchObject({ code: "pi_not_found" });
  });
});
