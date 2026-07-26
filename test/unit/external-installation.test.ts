import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveExternalPiInstallation } from "../../src/pi/external-installation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function executable(root: string, name: string, version = "0.82.1"): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o700);
  return path;
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pifleet-external-pi-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("external Pi installation resolver", () => {
  it("preserves an explicit selected path while observing its target and version", async () => {
    const directory = await root();
    const target = await executable(directory, "pi-target");
    const selected = join(directory, "pi");
    await symlink(target, selected);

    const installation = await resolveExternalPiInstallation({
      env: { PIFLEET_PI_EXECUTABLE: selected },
    });

    expect(installation).toMatchObject({
      selectedPath: selected,
      realPath: target,
      version: "0.82.1",
      nodePath: process.execPath,
    });
    expect(installation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects the first executable Pi on an absolute PATH", async () => {
    const directory = await root();
    const first = join(directory, "first");
    const second = join(directory, "second");
    await mkdir(first);
    await mkdir(second);
    const selected = await executable(first, "pi", "pi 0.82.1");
    await executable(second, "pi", "0.81.0");

    const installation = await resolveExternalPiInstallation({
      env: { PATH: `${first}:${second}` },
    });

    expect(installation.selectedPath).toBe(selected);
    expect(installation.version).toBe("0.82.1");
  });

  it("prefers an explicit path over PATH", async () => {
    const directory = await root();
    const explicit = await executable(directory, "explicit", "0.82.1");
    const pathDirectory = join(directory, "path");
    await mkdir(pathDirectory);
    await executable(pathDirectory, "pi", "0.81.0");

    const installation = await resolveExternalPiInstallation({
      env: { PIFLEET_PI_EXECUTABLE: explicit, PATH: pathDirectory },
    });

    expect(installation.selectedPath).toBe(explicit);
  });

  it("rejects relative explicit paths and relative PATH entries", async () => {
    await expect(
      resolveExternalPiInstallation({ env: { PIFLEET_PI_EXECUTABLE: "pi" } }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(resolveExternalPiInstallation({ env: { PATH: "." } })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  });

  it("distinguishes missing and non-executable selections", async () => {
    const directory = await root();
    const regularFile = join(directory, "not-executable");
    await writeFile(regularFile, "not executable");

    await expect(
      resolveExternalPiInstallation({ env: { PIFLEET_PI_EXECUTABLE: join(directory, "missing") } }),
    ).rejects.toMatchObject({ code: "pi_not_found" });
    await expect(
      resolveExternalPiInstallation({ env: { PIFLEET_PI_EXECUTABLE: regularFile } }),
    ).rejects.toMatchObject({ code: "pi_not_executable" });
  });

  it("rejects a malformed Pi version", async () => {
    const directory = await root();
    const selected = await executable(directory, "pi", "not-a-version");

    await expect(
      resolveExternalPiInstallation({ env: { PIFLEET_PI_EXECUTABLE: selected } }),
    ).rejects.toMatchObject({ code: "pi_version_unavailable" });
  });
});
