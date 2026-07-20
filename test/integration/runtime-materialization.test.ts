import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { materializeRuntime, verifyRuntime } from "../../src/platform/install/runtime-release.js";

interface Manifest {
  schemaVersion: number;
  package: { name: string; version: string };
  files: Array<{ path: string; bytes: number; sha256: string }>;
  trees: Array<{ path: string; files: number; bytes: number; sha256: string }>;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  sourceRoot: string;
  applicationRoot: string;
  manifest: Manifest;
  writeManifest(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-materialization-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const applicationRoot = join(root, "application");
  const contents: Record<string, string> = {
    "package.json": '{"name":"@elpapi42/pi-fleet","version":"9.9.9"}\n',
    "bin/pifleet.mjs": "#!/usr/bin/env node\n",
    "bin/pifleet-runtime.mjs": "#!/usr/bin/env node\n",
    "dist/cli.mjs": "export {};\n",
    "dist/runtime.mjs": "export {};\n",
    "dist/sqlite-worker.mjs": "export {};\n",
  };
  const files: Manifest["files"] = [];
  for (const [path, value] of Object.entries(contents)) {
    const target = join(sourceRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
    files.push({
      path,
      bytes: Buffer.byteLength(value),
      sha256: createHash("sha256").update(value).digest("hex"),
    });
  }
  const manifest: Manifest = {
    schemaVersion: 2,
    package: { name: "@elpapi42/pi-fleet", version: "9.9.9" },
    files,
    trees: [],
  };
  return {
    sourceRoot,
    applicationRoot,
    manifest,
    async writeManifest() {
      await writeFile(
        join(sourceRoot, "dist", "runtime-manifest.json"),
        `${JSON.stringify(manifest)}\n`,
      );
    },
  };
}

async function materialize(testFixture: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await testFixture.writeManifest();
  return materializeRuntime({
    sourceRoot: testFixture.sourceRoot,
    applicationRoot: testFixture.applicationRoot,
  });
}

describe("runtime materialization manifest validation", () => {
  it.each([
    ["invalid schema", (manifest: Manifest) => (manifest.schemaVersion = 3)],
    ["package mismatch", (manifest: Manifest) => (manifest.package.version = "other")],
    ["missing required artifact", (manifest: Manifest) => manifest.files.pop()],
    ["absolute path", (manifest: Manifest) => (manifest.files[0]!.path = "/tmp/escape")],
    ["parent path", (manifest: Manifest) => (manifest.files[0]!.path = "../escape")],
    ["backslash path", (manifest: Manifest) => (manifest.files[0]!.path = "bin\\escape")],
    ["duplicate path", (manifest: Manifest) => manifest.files.push({ ...manifest.files[0]! })],
    [
      "file tree overlap",
      (manifest: Manifest) =>
        manifest.trees.push({
          path: "dist",
          files: 0,
          bytes: 0,
          sha256: "0".repeat(64),
        }),
    ],
    ["invalid bytes", (manifest: Manifest) => (manifest.files[0]!.bytes = -1)],
    ["invalid hash", (manifest: Manifest) => (manifest.files[0]!.sha256 = "not-a-hash")],
  ])("rejects %s without creating a release", async (_name, mutate) => {
    const testFixture = await fixture();
    mutate(testFixture.manifest);

    await expect(materialize(testFixture)).rejects.toThrow(/manifest|runtime artifact|package/i);
    await expect(lstat(join(testFixture.applicationRoot, "releases"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked source core artifact without changing its target", async () => {
    const testFixture = await fixture();
    const sourceArtifact = join(testFixture.sourceRoot, "dist", "runtime.mjs");
    const original = await readFile(sourceArtifact);
    const external = join(testFixture.sourceRoot, "external-runtime.mjs");
    await writeFile(external, original);
    await rm(sourceArtifact);
    await symlink(external, sourceArtifact);

    await expect(materialize(testFixture)).rejects.toThrow(/symbolic link/i);
    await expect(readFile(external)).resolves.toEqual(original);
  });

  it("rejects a symlinked materialized core artifact", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    const artifact = join(release, "dist", "runtime.mjs");
    const external = join(testFixture.sourceRoot, "external-runtime.mjs");
    const contents = await readFile(artifact);
    await writeFile(external, contents);
    await rm(artifact);
    await symlink(external, artifact);

    await expect(verifyRuntime(release)).rejects.toThrow(/symbolic link/i);
    await expect(readFile(external)).resolves.toEqual(contents);
  });

  it("does not modify an existing release after source validation fails", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    const artifact = join(release, "dist", "runtime.mjs");
    const before = await readFile(artifact);
    testFixture.manifest.files[0]!.sha256 = "0".repeat(64);

    await expect(materialize(testFixture)).rejects.toThrow(/verification|manifest|artifact/i);
    await expect(readFile(artifact)).resolves.toEqual(before);
  });

  it("converges eight concurrent materializers on one verified release", async () => {
    const testFixture = await fixture();
    await testFixture.writeManifest();

    const releases = await Promise.all(
      Array.from({ length: 8 }, () =>
        materializeRuntime({
          sourceRoot: testFixture.sourceRoot,
          applicationRoot: testFixture.applicationRoot,
        }),
      ),
    );

    expect([...new Set(releases)]).toHaveLength(1);
    await expect(verifyRuntime(releases[0]!)).resolves.toBeUndefined();
  });

  it("leaves an unrelated staging directory untouched", async () => {
    const testFixture = await fixture();
    const stale = join(testFixture.applicationRoot, "releases", ".staging-unrelated");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "marker"), "keep");

    await materialize(testFixture);

    await expect(readFile(join(stale, "marker"), "utf8")).resolves.toBe("keep");
  });

  it("reuses an existing verified release without rewriting its core artifacts", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    const artifact = join(release, "dist", "runtime.mjs");
    const before = await lstat(artifact);

    await expect(materialize(testFixture)).resolves.toBe(release);

    const after = await lstat(artifact);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("fails closed without replacing an existing corrupt release", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    const artifact = join(release, "dist", "runtime.mjs");
    await writeFile(artifact, "corrupt");

    await expect(materialize(testFixture)).rejects.toThrow(/changed|verification|artifact/i);
    await expect(readFile(artifact, "utf8")).resolves.toBe("corrupt");
    await expect(readdir(join(testFixture.applicationRoot, "releases"))).resolves.toContain(
      release.split("/").at(-1),
    );
  });
});
