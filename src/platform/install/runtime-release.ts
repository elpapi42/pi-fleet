import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { hashDirectoryTree, type TreeIntegrity } from "./tree-integrity.js";

interface RuntimeManifest {
  readonly schemaVersion: 2;
  readonly package: { readonly name: string; readonly version: string };
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly trees: readonly TreeIntegrity[];
}

export async function materializeRuntime(options: {
  readonly sourceRoot: string;
  readonly applicationRoot: string;
}): Promise<string> {
  const sourceRoot = resolve(options.sourceRoot);
  const applicationRoot = resolve(options.applicationRoot);
  await ensurePrivateDirectory(applicationRoot);
  const manifestBytes = await readFile(join(sourceRoot, "dist", "runtime-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as RuntimeManifest;
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
    await rename(staging, destination);
    return destination;
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRuntime(root: string, manifest?: RuntimeManifest): Promise<void> {
  const expected =
    manifest ??
    (JSON.parse(
      await readFile(join(root, "dist", "runtime-manifest.json"), "utf8"),
    ) as RuntimeManifest);
  const resolvedRoot = resolve(root);
  for (const file of expected.files) {
    const path = resolveInside(resolvedRoot, file.path);
    const info = await stat(path);
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

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Runtime manifest contains an unsafe path ${path}`);
  }
  return resolved;
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
