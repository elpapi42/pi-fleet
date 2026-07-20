import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

const entryPoints = [
  ["src/entry/cli.ts", "dist/cli.mjs", "dist/cli-meta.json"],
  ["src/entry/runtime.ts", "dist/runtime.mjs", "dist/runtime-meta.json"],
  ["src/store/sqlite-worker.ts", "dist/sqlite-worker.mjs", "dist/sqlite-worker-meta.json"],
  ["src/entry/installer.ts", "dist/installer.mjs", "dist/installer-meta.json"],
];

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });

for (const [entryPoint, outfile, metafile] of entryPoints) {
  const result = await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    metafile: true,
    outfile,
    platform: "node",
    sourcemap: true,
    target: "node22.19",
    treeShaking: true,
  });
  await writeFile(metafile, `${JSON.stringify(result.metafile, null, 2)}\n`);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const files = [];
const artifactPaths = [
  ...(await readdir("dist")).sort().map((name) => join("dist", name)),
  ...(await readdir("bin")).sort().map((name) => join("bin", name)),
  "package.json",
];
for (const path of artifactPaths) {
  const contents = await readFile(path);
  files.push({
    path,
    bytes: (await stat(path)).size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const dependencyTrees = [];
for (const path of productionPackageRoots(packageLock)) {
  if (!(await pathExists(path))) continue;
  dependencyTrees.push(await hashDirectoryTree(path, path));
}
await writeFile(
  "dist/runtime-manifest.json",
  `${JSON.stringify(
    {
      schemaVersion: 2,
      package: { name: packageJson.name, version: packageJson.version },
      managedPi: "@earendil-works/pi-coding-agent@0.80.10",
      files,
      trees: dependencyTrees,
    },
    null,
    2,
  )}\n`,
);

function productionPackageRoots(packageLock) {
  return Object.entries(packageLock.packages ?? {})
    .filter(([path, metadata]) => {
      if (!path.startsWith("node_modules/") || metadata?.dev === true) return false;
      const remainder = path.slice("node_modules/".length);
      return !remainder.includes("/node_modules/");
    })
    .map(([path]) => path)
    .sort();
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function hashDirectoryTree(root, manifestPath) {
  const resolvedRoot = resolve(root);
  const entries = await collectFiles(resolvedRoot, resolvedRoot);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    const contents = await readFile(entry.absolutePath);
    bytes += contents.length;
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(String(contents.length));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return {
    path: manifestPath,
    files: entries.length,
    bytes,
    sha256: hash.digest("hex"),
  };
}

async function collectFiles(root, directory) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolutePath = join(directory, name);
    const linkInfo = await lstat(absolutePath);
    const info = linkInfo.isSymbolicLink() ? await stat(absolutePath) : linkInfo;
    if (info.isDirectory()) {
      if (linkInfo.isSymbolicLink()) {
        throw new Error(`Runtime dependency tree contains a directory symlink: ${absolutePath}`);
      }
      output.push(...(await collectFiles(root, absolutePath)));
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Runtime dependency tree contains an unsupported entry: ${absolutePath}`);
    }
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (relativePath.length === 0 || relativePath.startsWith("../")) {
      throw new Error(`Runtime dependency path escapes its root: ${absolutePath}`);
    }
    output.push({ absolutePath, relativePath });
  }
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
