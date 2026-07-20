import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

import { hashDirectoryTree, type TreeIntegrity } from "./tree-integrity.js";

interface RuntimeManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface RuntimeManifest {
  readonly schemaVersion: 2;
  readonly package: { readonly name: string; readonly version: string };
  readonly files: readonly RuntimeManifestFile[];
  readonly trees: readonly TreeIntegrity[];
}

const requiredRuntimeArtifacts = new Set([
  "package.json",
  "bin/pifleet.mjs",
  "bin/pifleet-runtime.mjs",
  "dist/cli.mjs",
  "dist/runtime.mjs",
  "dist/sqlite-worker.mjs",
]);

export async function materializeRuntime(options: {
  readonly sourceRoot: string;
  readonly applicationRoot: string;
}): Promise<string> {
  const sourceRoot = resolve(options.sourceRoot);
  const manifestBytes = await readFile(join(sourceRoot, "dist", "runtime-manifest.json"));
  const manifest = await parseRuntimeManifest(manifestBytes, sourceRoot);
  await verifyRuntime(sourceRoot, manifest);

  const applicationRoot = resolve(options.applicationRoot);
  await ensurePrivateDirectory(applicationRoot);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex").slice(0, 16);
  const releasesRoot = join(applicationRoot, "releases");
  await ensurePrivateDirectory(releasesRoot);
  const destination = join(releasesRoot, `${manifest.package.version}-${manifestHash}`);

  if (await pathExists(destination)) {
    await verifyRuntime(destination, manifest);
    return destination;
  }

  const staging = join(releasesRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await cp(join(sourceRoot, "dist"), join(staging, "dist"), {
      recursive: true,
      dereference: true,
    });
    await cp(join(sourceRoot, "bin"), join(staging, "bin"), { recursive: true, dereference: true });
    await cp(join(sourceRoot, "package.json"), join(staging, "package.json"));
    for (const tree of manifest.trees) {
      const source = resolveInside(sourceRoot, tree.path);
      const destination = resolveInside(staging, tree.path);
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      await cp(source, destination, { recursive: true, dereference: true });
    }
    await verifyRuntime(staging, manifest);
    await chmod(staging, 0o700);
    try {
      await rename(staging, destination);
    } catch (error: unknown) {
      if (!isDestinationRace(error) || !(await pathExists(destination))) throw error;
      await verifyRuntime(destination, manifest);
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyRuntime(root: string, manifest?: RuntimeManifest): Promise<void> {
  const resolvedRoot = resolve(root);
  const expected =
    manifest ??
    (await parseRuntimeManifest(
      await readFile(join(resolvedRoot, "dist", "runtime-manifest.json")),
      resolvedRoot,
    ));
  if (manifest !== undefined) await validateRuntimeManifest(manifest, resolvedRoot);

  for (const file of expected.files) {
    const path = resolveInside(resolvedRoot, file.path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Runtime artifact ${file.path} must not be a symbolic link`);
    }
    if (!info.isFile() || info.size !== file.bytes) {
      throw new Error(`Runtime artifact ${file.path} has changed`);
    }
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (hash !== file.sha256) {
      throw new Error(`Runtime artifact ${file.path} failed verification`);
    }
  }
  for (const expectedTree of expected.trees) {
    const treeRoot = resolveInside(resolvedRoot, expectedTree.path);
    const actualTree = await hashDirectoryTree(treeRoot, expectedTree.path);
    if (
      actualTree.files !== expectedTree.files ||
      actualTree.bytes !== expectedTree.bytes ||
      actualTree.sha256 !== expectedTree.sha256
    ) {
      throw new Error(`Runtime dependency tree ${expectedTree.path} failed verification`);
    }
  }
}

async function parseRuntimeManifest(bytes: Buffer, root: string): Promise<RuntimeManifest> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Runtime manifest is not valid JSON");
  }
  await validateRuntimeManifest(candidate, root);
  return candidate as RuntimeManifest;
}

async function validateRuntimeManifest(candidate: unknown, root: string): Promise<void> {
  if (!isRecord(candidate) || candidate.schemaVersion !== 2) {
    throw new Error("Runtime manifest has an unsupported schema version");
  }
  if (
    !isRecord(candidate.package) ||
    typeof candidate.package.name !== "string" ||
    typeof candidate.package.version !== "string"
  ) {
    throw new Error("Runtime manifest has an invalid package identity");
  }
  const packageIdentity = await readPackageIdentity(root);
  if (
    candidate.package.name !== packageIdentity.name ||
    candidate.package.version !== packageIdentity.version
  ) {
    throw new Error("Runtime manifest package identity does not match package.json");
  }
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.trees)) {
    throw new Error("Runtime manifest has invalid artifact lists");
  }

  const filePaths = new Set<string>();
  for (const file of candidate.files) {
    if (
      !isRecord(file) ||
      !isManifestPath(file.path) ||
      !isValidSize(file.bytes) ||
      !isSha256(file.sha256)
    ) {
      throw new Error("Runtime manifest contains an invalid artifact");
    }
    if (filePaths.has(file.path))
      throw new Error(`Runtime manifest has duplicate path ${file.path}`);
    filePaths.add(file.path);
  }
  for (const required of requiredRuntimeArtifacts) {
    if (!filePaths.has(required)) {
      throw new Error(`Runtime manifest is missing required artifact ${required}`);
    }
  }

  const treePaths = new Set<string>();
  for (const tree of candidate.trees) {
    if (
      !isRecord(tree) ||
      !isManifestPath(tree.path) ||
      !isValidSize(tree.files) ||
      !isValidSize(tree.bytes) ||
      !isSha256(tree.sha256)
    ) {
      throw new Error("Runtime manifest contains an invalid dependency tree");
    }
    if (treePaths.has(tree.path))
      throw new Error(`Runtime manifest has duplicate path ${tree.path}`);
    treePaths.add(tree.path);
  }
  const allPaths = [...filePaths, ...treePaths];
  for (let index = 0; index < allPaths.length; index += 1) {
    for (let other = index + 1; other < allPaths.length; other += 1) {
      const left = allPaths[index]!;
      const right = allPaths[other]!;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new Error(`Runtime manifest has overlapping paths ${left} and ${right}`);
      }
    }
  }
}

async function readPackageIdentity(root: string): Promise<{ name: string; version: string }> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("Runtime package.json is not valid JSON");
  }
  if (
    !isRecord(candidate) ||
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "string"
  ) {
    throw new Error("Runtime package.json has an invalid identity");
  }
  return { name: candidate.name, version: candidate.version };
}

function resolveInside(root: string, path: string): string {
  if (!isManifestPath(path)) throw new Error(`Runtime manifest contains an unsafe path ${path}`);
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Runtime manifest contains an unsafe path ${path}`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isManifestPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    posix.normalize(value) === value &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isValidSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDestinationRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe runtime release path ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Runtime release path ${path} is not owned by the current user`);
  }
  await chmod(path, 0o700);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
