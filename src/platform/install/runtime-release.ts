import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

import { hashDirectoryTree, type TreeIntegrity } from "./tree-integrity.js";

interface RuntimeManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface RuntimeDependency {
  readonly path: string;
  readonly name: string;
  readonly version: string;
}

interface RuntimeClosure {
  readonly sourceManifestSha256: string;
  readonly tree: TreeIntegrity;
}

interface RuntimeManifest {
  readonly schemaVersion: 3;
  readonly package: { readonly name: string; readonly version: string };
  readonly managedPi: string;
  readonly files: readonly RuntimeManifestFile[];
  readonly dependencies: readonly RuntimeDependency[];
  readonly closure?: RuntimeClosure;
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

const requiredRuntimeArtifacts = new Set([
  "package.json",
  "bin/pifleet.mjs",
  "bin/pifleet-runtime.mjs",
  "dist/cli.mjs",
  "dist/runtime.mjs",
  "dist/sqlite-worker.mjs",
]);
const dependencyTreePath = "node_modules";

export async function materializeRuntime(options: {
  readonly sourceRoot: string;
  readonly applicationRoot: string;
  readonly hooks?: {
    readonly afterDependencyCopy?: () => Promise<void>;
  };
}): Promise<string> {
  const sourceRoot = resolve(options.sourceRoot);
  const manifestBytes = await readFile(join(sourceRoot, "dist", "runtime-manifest.json"));
  const sourceManifest = await parseRuntimeManifest(manifestBytes, sourceRoot);
  if (sourceManifest.closure !== undefined) {
    await verifyRuntime(sourceRoot);
    return sourceRoot;
  }
  await verifyRuntimeFiles(sourceRoot, sourceManifest);
  await verifyDependencyIdentities(sourceRoot, sourceManifest.dependencies);

  const sourceTreeRoot = resolveInside(sourceRoot, dependencyTreePath);
  const sourceTreeBefore = await hashDirectoryTree(sourceTreeRoot, dependencyTreePath);
  const sourceManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const materializedManifest: RuntimeManifest = {
    ...sourceManifest,
    closure: { sourceManifestSha256, tree: sourceTreeBefore },
  };
  const materializedManifestBytes = serializeManifest(materializedManifest);
  const closureHash = createHash("sha256")
    .update(sourceManifestSha256)
    .update("\0")
    .update(JSON.stringify(sourceTreeBefore))
    .digest("hex")
    .slice(0, 16);

  const applicationRoot = resolve(options.applicationRoot);
  await ensurePrivateDirectory(applicationRoot);
  const releasesRoot = join(applicationRoot, "releases");
  await ensurePrivateDirectory(releasesRoot);
  const destination = join(releasesRoot, `${sourceManifest.package.version}-${closureHash}`);

  if (await pathExists(destination)) {
    await verifyExpectedRuntime(destination, materializedManifest, materializedManifestBytes);
    return destination;
  }

  const staging = join(releasesRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await cp(join(sourceRoot, "dist"), join(staging, "dist"), {
      recursive: true,
      dereference: true,
    });
    await cp(join(sourceRoot, "bin"), join(staging, "bin"), {
      recursive: true,
      dereference: true,
    });
    await cp(join(sourceRoot, "package.json"), join(staging, "package.json"));
    await cp(sourceTreeRoot, join(staging, dependencyTreePath), {
      recursive: true,
      dereference: true,
    });
    await options.hooks?.afterDependencyCopy?.();

    const stagedTree = await hashDirectoryTree(
      join(staging, dependencyTreePath),
      dependencyTreePath,
    );
    assertSameTree(sourceTreeBefore, stagedTree, "copied dependency closure");
    const sourceTreeAfter = await hashDirectoryTree(sourceTreeRoot, dependencyTreePath);
    assertSameTree(sourceTreeBefore, sourceTreeAfter, "source dependency closure");

    await writeFile(join(staging, "dist", "runtime-manifest.json"), materializedManifestBytes);
    await verifyExpectedRuntime(staging, materializedManifest, materializedManifestBytes);
    await chmod(staging, 0o700);
    try {
      await rename(staging, destination);
    } catch (error: unknown) {
      if (!isDestinationRace(error) || !(await pathExists(destination))) throw error;
      await verifyExpectedRuntime(destination, materializedManifest, materializedManifestBytes);
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyRuntime(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const manifestBytes = await readFile(join(resolvedRoot, "dist", "runtime-manifest.json"));
  const manifest = await parseRuntimeManifest(manifestBytes, resolvedRoot);
  if (manifest.closure === undefined) {
    throw new Error("Runtime release manifest is missing its materialized closure");
  }
  await verifyRuntimeFiles(resolvedRoot, manifest);
  await verifyDependencyIdentities(resolvedRoot, manifest.dependencies);
  const actualTree = await hashDirectoryTree(
    resolveInside(resolvedRoot, dependencyTreePath),
    dependencyTreePath,
  );
  assertSameTree(manifest.closure.tree, actualTree, "materialized dependency closure");
}

async function verifyExpectedRuntime(
  root: string,
  expected: RuntimeManifest,
  expectedBytes: Buffer,
): Promise<void> {
  const manifestPath = join(root, "dist", "runtime-manifest.json");
  const actualBytes = await readFile(manifestPath);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error("Materialized runtime manifest does not match the expected closure");
  }
  const actual = await parseRuntimeManifest(actualBytes, root);
  if (actual.closure === undefined || expected.closure === undefined) {
    throw new Error("Materialized runtime manifest is missing its closure");
  }
  await verifyRuntimeFiles(root, actual);
  await verifyDependencyIdentities(root, actual.dependencies);
  const actualTree = await hashDirectoryTree(
    resolveInside(root, dependencyTreePath),
    dependencyTreePath,
  );
  assertSameTree(expected.closure.tree, actualTree, "materialized dependency closure");
}

async function verifyRuntimeFiles(root: string, manifest: RuntimeManifest): Promise<void> {
  for (const file of manifest.files) {
    const path = resolveInside(root, file.path);
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
}

async function verifyDependencyIdentities(
  root: string,
  dependencies: readonly RuntimeDependency[],
): Promise<void> {
  const nodeModules = resolveInside(root, dependencyTreePath);
  const modulesInfo = await lstat(nodeModules);
  if (!modulesInfo.isDirectory() || modulesInfo.isSymbolicLink()) {
    throw new Error("Runtime dependency closure must be a regular directory");
  }
  for (const dependency of dependencies) {
    const packageRoot = resolveInside(root, dependency.path);
    const packageInfo = await lstat(packageRoot);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
      throw new Error(`Runtime dependency ${dependency.name} must be a regular directory`);
    }
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJsonInfo = await lstat(packageJsonPath);
    if (!packageJsonInfo.isFile() || packageJsonInfo.isSymbolicLink()) {
      throw new Error(`Runtime dependency ${dependency.name} has an unsafe package.json`);
    }
    const identity = await readPackageMetadata(packageRoot);
    if (identity.name !== dependency.name || identity.version !== dependency.version) {
      throw new Error(`Runtime dependency ${dependency.name} has an unexpected identity`);
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
  if (!isRecord(candidate) || candidate.schemaVersion !== 3) {
    throw new Error("Runtime manifest has an unsupported schema version");
  }
  if (
    !isRecord(candidate.package) ||
    typeof candidate.package.name !== "string" ||
    typeof candidate.package.version !== "string" ||
    typeof candidate.managedPi !== "string"
  ) {
    throw new Error("Runtime manifest has an invalid package identity");
  }
  const packageMetadata = await readPackageMetadata(root);
  if (
    candidate.package.name !== packageMetadata.name ||
    candidate.package.version !== packageMetadata.version
  ) {
    throw new Error("Runtime manifest package identity does not match package.json");
  }
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.dependencies)) {
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
    if (filePaths.has(file.path)) {
      throw new Error(`Runtime manifest has duplicate path ${file.path}`);
    }
    filePaths.add(file.path);
  }
  for (const required of requiredRuntimeArtifacts) {
    if (!filePaths.has(required)) {
      throw new Error(`Runtime manifest is missing required artifact ${required}`);
    }
  }

  const dependencyPaths = new Set<string>();
  const dependencyNames = new Set<string>();
  for (const dependency of candidate.dependencies) {
    if (
      !isRecord(dependency) ||
      !isManifestPath(dependency.path) ||
      typeof dependency.name !== "string" ||
      dependency.name.length === 0 ||
      typeof dependency.version !== "string" ||
      dependency.version.length === 0 ||
      dependency.path !== `node_modules/${dependency.name}`
    ) {
      throw new Error("Runtime manifest contains an invalid dependency declaration");
    }
    if (dependencyPaths.has(dependency.path) || dependencyNames.has(dependency.name)) {
      throw new Error(`Runtime manifest has duplicate dependency ${dependency.name}`);
    }
    dependencyPaths.add(dependency.path);
    dependencyNames.add(dependency.name);
  }
  const expectedDependencies = packageMetadata.dependencies;
  if (
    dependencyNames.size !== Object.keys(expectedDependencies).length ||
    [...dependencyNames].some(
      (name) =>
        expectedDependencies[name] !==
        (candidate.dependencies as Array<Record<string, unknown>>).find(
          (dependency) => dependency.name === name,
        )?.version,
    )
  ) {
    throw new Error("Runtime manifest dependencies do not match package.json");
  }

  for (const filePath of filePaths) {
    for (const dependencyPath of dependencyPaths) {
      if (
        filePath === dependencyPath ||
        filePath.startsWith(`${dependencyPath}/`) ||
        dependencyPath.startsWith(`${filePath}/`)
      ) {
        throw new Error(`Runtime manifest has overlapping paths ${filePath} and ${dependencyPath}`);
      }
    }
  }

  if (candidate.closure !== undefined) {
    if (
      !isRecord(candidate.closure) ||
      !isSha256(candidate.closure.sourceManifestSha256) ||
      !isTreeIntegrity(candidate.closure.tree) ||
      candidate.closure.tree.path !== dependencyTreePath
    ) {
      throw new Error("Runtime manifest contains an invalid materialized closure");
    }
  }
}

async function readPackageMetadata(root: string): Promise<PackageMetadata> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("Runtime package.json is not valid JSON");
  }
  if (
    !isRecord(candidate) ||
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "string" ||
    (candidate.dependencies !== undefined && !isRecord(candidate.dependencies)) ||
    (isRecord(candidate.dependencies) &&
      Object.values(candidate.dependencies).some((version) => typeof version !== "string"))
  ) {
    throw new Error("Runtime package.json has invalid package metadata");
  }
  return {
    name: candidate.name,
    version: candidate.version,
    dependencies: isRecord(candidate.dependencies)
      ? (candidate.dependencies as Record<string, string>)
      : {},
  };
}

function serializeManifest(manifest: RuntimeManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function assertSameTree(expected: TreeIntegrity, actual: TreeIntegrity, label: string): void {
  if (
    expected.path !== actual.path ||
    expected.files !== actual.files ||
    expected.bytes !== actual.bytes ||
    expected.sha256 !== actual.sha256
  ) {
    throw new Error(`Runtime ${label} changed during materialization`);
  }
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

function isTreeIntegrity(value: unknown): value is TreeIntegrity {
  return (
    isRecord(value) &&
    isManifestPath(value.path) &&
    isValidSize(value.files) &&
    isValidSize(value.bytes) &&
    isSha256(value.sha256)
  );
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
