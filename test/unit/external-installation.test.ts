import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveExternalPiInstallation } from "../../src/pi/external-installation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function executable(
  root: string,
  name: string,
  body = "printf '%s\\n' '0.82.1'\n",
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o700);
  return path;
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pifleet-external-pi-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

function options(piPath: string, nodePath = process.execPath) {
  return { env: { PIFLEET_PI_EXECUTABLE: piPath }, nodePath };
}

async function expectPidAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`process ${String(pid)} survived version probe cleanup`);
}

describe("external Pi installation resolver", () => {
  it("preserves an explicit selected path while observing its target and version", async () => {
    const directory = await root();
    const target = await executable(directory, "pi-target");
    const selected = join(directory, "pi");
    await symlink(target, selected);

    const installation = await resolveExternalPiInstallation(options(selected));

    expect(installation).toMatchObject({
      selectedPath: selected,
      realPath: target,
      version: "0.82.1",
      nodePath: process.execPath,
    });
    expect(installation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects the first executable Pi and node on an absolute PATH", async () => {
    const directory = await root();
    const first = join(directory, "first");
    const second = join(directory, "second");
    await mkdir(first);
    await mkdir(second);
    const selected = await executable(first, "pi", "printf '%s\\n' 'pi 0.82.1'\n");
    const node = await executable(first, "node");
    await executable(second, "pi", "printf '%s\\n' '0.81.0'\n");
    await executable(second, "node");

    const installation = await resolveExternalPiInstallation({
      env: { PATH: `${first}:${second}` },
    });

    expect(installation.selectedPath).toBe(selected);
    expect(installation.nodePath).toBe(node);
    expect(installation.version).toBe("0.82.1");
  });

  it("prefers an explicit Pi path over PATH", async () => {
    const directory = await root();
    const explicit = await executable(directory, "explicit");
    const pathDirectory = join(directory, "path");
    await mkdir(pathDirectory);
    await executable(pathDirectory, "pi", "printf '%s\\n' '0.81.0'\n");

    const installation = await resolveExternalPiInstallation({
      env: { PIFLEET_PI_EXECUTABLE: explicit, PATH: dirname(process.execPath) },
    });

    expect(installation.selectedPath).toBe(explicit);
  });

  it("rejects relative explicit paths and relative PATH entries", async () => {
    await expect(
      resolveExternalPiInstallation({
        env: { PIFLEET_PI_EXECUTABLE: "pi" },
        nodePath: process.execPath,
      }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(
      resolveExternalPiInstallation({ env: { PATH: "." }, nodePath: process.execPath }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("distinguishes missing and non-executable selections", async () => {
    const directory = await root();
    const regularFile = join(directory, "not-executable");
    await writeFile(regularFile, "not executable");

    await expect(
      resolveExternalPiInstallation(options(join(directory, "missing"))),
    ).rejects.toMatchObject({ code: "pi_not_found" });
    await expect(resolveExternalPiInstallation(options(regularFile))).rejects.toMatchObject({
      code: "pi_not_executable",
    });
  });

  it("rejects malformed, nonzero, and invalid UTF-8 version output", async () => {
    const directory = await root();
    const malformed = await executable(directory, "malformed", "printf '%s\\n' 'not-a-version'\n");
    const nonzero = await executable(directory, "nonzero", "exit 7\n");
    const invalidUtf8 = await executable(directory, "invalid-utf8", "printf '\\377\\n'\n");

    for (const selected of [malformed, nonzero, invalidUtf8]) {
      await expect(resolveExternalPiInstallation(options(selected))).rejects.toMatchObject({
        code: "pi_version_unavailable",
      });
    }
  });

  it("kills a timed-out version process group and waits for it to disappear", async () => {
    const directory = await root();
    const pidPath = join(directory, "child.pid");
    const selected = await executable(
      directory,
      "hanging-pi",
      `sleep 30 &\nprintf '%s' "$!" > "${pidPath}"\nwait\n`,
    );

    await expect(
      resolveExternalPiInstallation({ ...options(selected), versionTimeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "pi_version_unavailable" });

    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    expect(pid).toBeGreaterThan(0);
    await expectPidAbsent(pid);
  });

  it("rejects oversized version output", async () => {
    const directory = await root();
    const selected = await executable(directory, "oversized", "yes x | head -c 4097\n");

    await expect(
      resolveExternalPiInstallation({ ...options(selected), maxVersionOutputBytes: 64 }),
    ).rejects.toMatchObject({ code: "pi_version_unavailable" });
  });

  it("changes the fingerprint when executable target contents change", async () => {
    const directory = await root();
    const selected = await executable(directory, "pi");
    const first = await resolveExternalPiInstallation(options(selected));
    await writeFile(selected, "#!/bin/sh\nprintf '%s\\n' '0.82.1'\n# changed\n");
    await chmod(selected, 0o700);
    const second = await resolveExternalPiInstallation(options(selected));

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("retries once when a selected symlink retargets during observation", async () => {
    const directory = await root();
    const first = await executable(directory, "pi-one");
    const second = await executable(directory, "pi-two", "printf '%s\\n' '0.82.2'\n");
    const selected = join(directory, "pi");
    await symlink(first, selected);
    let calls = 0;

    const installation = await resolveExternalPiInstallation({
      ...options(selected),
      async versionCommand() {
        calls += 1;
        if (calls === 1) {
          await unlink(selected);
          await symlink(second, selected);
        }
        return calls === 1 ? "0.82.1\n" : "0.82.2\n";
      },
    });

    expect(calls).toBe(2);
    expect(installation).toMatchObject({
      selectedPath: selected,
      realPath: second,
      version: "0.82.2",
    });
  });

  it("fails closed when the selected symlink keeps changing during observation", async () => {
    const directory = await root();
    const first = await executable(directory, "pi-one");
    const second = await executable(directory, "pi-two", "printf '%s\\n' '0.82.2'\n");
    const selected = join(directory, "pi");
    await symlink(first, selected);
    let next = second;

    await expect(
      resolveExternalPiInstallation({
        ...options(selected),
        async versionCommand() {
          await unlink(selected);
          await symlink(next, selected);
          next = next === first ? second : first;
          return "0.82.1\n";
        },
      }),
    ).rejects.toMatchObject({ code: "pi_installation_changed" });
  });

  it("supports selected Pi paths containing spaces and Unicode", async () => {
    const directory = await root();
    const selected = await executable(directory, "Pi ✓ with spaces");

    await expect(resolveExternalPiInstallation(options(selected))).resolves.toMatchObject({
      selectedPath: selected,
    });
  });

  it("rejects an invalid explicit Node path", async () => {
    const directory = await root();
    const selected = await executable(directory, "pi");

    await expect(
      resolveExternalPiInstallation({
        ...options(selected),
        nodePath: join(directory, "missing-node"),
      }),
    ).rejects.toMatchObject({ code: "pi_not_executable" });
  });
});
