import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { materializeRuntime, verifyRuntime } from "../../src/platform/install/runtime-release.js";

interface Manifest {
  schemaVersion: number;
  package: { name: string; version: string };
  managedPi: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  dependencies: Array<{ path: string; name: string; version: string }>;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(applicationRoot?: string): Promise<{
  root: string;
  sourceRoot: string;
  applicationRoot: string;
  manifest: Manifest;
  writeManifest(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-materialization-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const resolvedApplicationRoot = applicationRoot ?? join(root, "application");
  const packageJson = {
    name: "@elpapi42/pi-fleet",
    version: "9.9.9",
    dependencies: { "fixture-dep": "1.0.0" },
  };
  const contents: Record<string, string> = {
    "package.json": `${JSON.stringify(packageJson)}\n`,
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
  const dependencyRoot = join(sourceRoot, "node_modules", "fixture-dep");
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(
    join(dependencyRoot, "package.json"),
    `${JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" })}\n`,
  );
  await writeFile(join(dependencyRoot, "index.js"), "export default 'fixture';\n");

  const manifest: Manifest = {
    schemaVersion: 3,
    package: { name: "@elpapi42/pi-fleet", version: "9.9.9" },
    managedPi: "fixture-dep@1.0.0",
    files,
    dependencies: [{ path: "node_modules/fixture-dep", name: "fixture-dep", version: "1.0.0" }],
  };
  return {
    root,
    sourceRoot,
    applicationRoot: resolvedApplicationRoot,
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
    ["invalid schema", (manifest: Manifest) => (manifest.schemaVersion = 2)],
    ["package mismatch", (manifest: Manifest) => (manifest.package.version = "other")],
    ["missing required artifact", (manifest: Manifest) => manifest.files.pop()],
    ["absolute path", (manifest: Manifest) => (manifest.files[0]!.path = "/tmp/escape")],
    ["parent path", (manifest: Manifest) => (manifest.files[0]!.path = "../escape")],
    ["backslash path", (manifest: Manifest) => (manifest.files[0]!.path = "bin\\escape")],
    ["duplicate path", (manifest: Manifest) => manifest.files.push({ ...manifest.files[0]! })],
    [
      "file dependency overlap",
      (manifest: Manifest) => (manifest.files[0]!.path = "node_modules/fixture-dep/index.js"),
    ],
    ["invalid bytes", (manifest: Manifest) => (manifest.files[0]!.bytes = -1)],
    ["invalid hash", (manifest: Manifest) => (manifest.files[0]!.sha256 = "not-a-hash")],
    ["missing dependency", (manifest: Manifest) => manifest.dependencies.pop()],
    ["wrong dependency name", (manifest: Manifest) => (manifest.dependencies[0]!.name = "other")],
    [
      "wrong dependency version",
      (manifest: Manifest) => (manifest.dependencies[0]!.version = "2.0.0"),
    ],
  ])("rejects %s without creating a release", async (_name, mutate) => {
    const testFixture = await fixture();
    mutate(testFixture.manifest);

    await expect(materialize(testFixture)).rejects.toThrow(
      /manifest|runtime artifact|package|dependency/i,
    );
    await expect(lstat(join(testFixture.applicationRoot, "releases"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a missing installed direct dependency", async () => {
    const testFixture = await fixture();
    await rm(join(testFixture.sourceRoot, "node_modules", "fixture-dep"), { recursive: true });
    await expect(materialize(testFixture)).rejects.toThrow(/dependency|ENOENT/i);
  });

  it("rejects an installed dependency with the wrong identity", async () => {
    const testFixture = await fixture();
    await writeFile(
      join(testFixture.sourceRoot, "node_modules", "fixture-dep", "package.json"),
      `${JSON.stringify({ name: "fixture-dep", version: "2.0.0" })}\n`,
    );
    await expect(materialize(testFixture)).rejects.toThrow(/unexpected identity/i);
  });

  it("allows internal file symlinks and materializes them as verified regular files", async () => {
    const testFixture = await fixture();
    const dependencyRoot = join(testFixture.sourceRoot, "node_modules", "fixture-dep");
    await symlink("index.js", join(dependencyRoot, "linked.js"));

    const release = await materialize(testFixture);
    const materializedLink = join(release, "node_modules", "fixture-dep", "linked.js");
    expect((await lstat(materializedLink)).isSymbolicLink()).toBe(false);
    await expect(verifyRuntime(release)).resolves.toBeUndefined();
  });

  it("rejects external file symlinks in the dependency closure", async () => {
    const testFixture = await fixture();
    const external = join(testFixture.root, "external.js");
    await writeFile(external, "external\n");
    await symlink(
      external,
      join(testFixture.sourceRoot, "node_modules", "fixture-dep", "external.js"),
    );

    await expect(materialize(testFixture)).rejects.toThrow(/external file symlink/i);
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

  it("detects source dependency mutation after copying", async () => {
    const testFixture = await fixture();
    await testFixture.writeManifest();
    const sourceDependency = join(
      testFixture.sourceRoot,
      "node_modules",
      "fixture-dep",
      "index.js",
    );

    await expect(
      materializeRuntime({
        sourceRoot: testFixture.sourceRoot,
        applicationRoot: testFixture.applicationRoot,
        hooks: {
          async afterDependencyCopy() {
            await writeFile(sourceDependency, "mutated after copy\n");
          },
        },
      }),
    ).rejects.toThrow(/source dependency closure changed/i);
    await expect(readdir(join(testFixture.applicationRoot, "releases"))).resolves.not.toContain(
      expect.stringMatching(/^9\.9\.9-/),
    );
  });

  it("uses a distinct immutable release identity for a different installed closure", async () => {
    const testFixture = await fixture();
    const first = await materialize(testFixture);
    await writeFile(
      join(testFixture.sourceRoot, "node_modules", "fixture-dep", "harmless.txt"),
      "legitimate npm layout difference\n",
    );
    const second = await materialize(testFixture);

    expect(second).not.toBe(first);
    await expect(verifyRuntime(first)).resolves.toBeUndefined();
    await expect(verifyRuntime(second)).resolves.toBeUndefined();
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

  it("materializes different closures concurrently without collision", async () => {
    const applicationOwner = await fixture();
    const other = await fixture(applicationOwner.applicationRoot);
    await applicationOwner.writeManifest();
    await other.writeManifest();
    await writeFile(
      join(other.sourceRoot, "node_modules", "fixture-dep", "other.txt"),
      "different closure\n",
    );

    const releases = await Promise.all([
      materializeRuntime({
        sourceRoot: applicationOwner.sourceRoot,
        applicationRoot: applicationOwner.applicationRoot,
      }),
      materializeRuntime({
        sourceRoot: other.sourceRoot,
        applicationRoot: other.applicationRoot,
      }),
    ]);

    expect([...new Set(releases)]).toHaveLength(2);
    await Promise.all(releases.map((release) => verifyRuntime(release)));
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

  it("uses an already materialized closure as its own restart source", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);

    await expect(
      materializeRuntime({
        sourceRoot: release,
        applicationRoot: testFixture.applicationRoot,
      }),
    ).resolves.toBe(release);
  });

  it("fails closed without replacing an existing corrupt release", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    const artifact = join(release, "dist", "runtime.mjs");
    await writeFile(artifact, "corrupt");

    await expect(materialize(testFixture)).rejects.toThrow(/changed|verification|artifact/i);
    await expect(readFile(artifact, "utf8")).resolves.toBe("corrupt");
  });

  it("detects corruption of a materialized dependency closure", async () => {
    const testFixture = await fixture();
    const release = await materialize(testFixture);
    await writeFile(
      join(release, "node_modules", "fixture-dep", "index.js"),
      "materialized corruption\n",
    );

    await expect(verifyRuntime(release)).rejects.toThrow(/dependency closure changed/i);
  });
});
