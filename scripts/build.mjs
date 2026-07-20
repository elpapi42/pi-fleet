import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const dependencies = Object.entries(packageJson.dependencies ?? {})
  .map(([name, version]) => ({
    path: `node_modules/${name}`,
    name,
    version,
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

await writeFile(
  "dist/runtime-manifest.json",
  `${JSON.stringify(
    {
      schemaVersion: 3,
      package: { name: packageJson.name, version: packageJson.version },
      managedPi: `@earendil-works/pi-coding-agent@${String(
        packageJson.dependencies["@earendil-works/pi-coding-agent"],
      )}`,
      files,
      dependencies,
    },
    null,
    2,
  )}\n`,
);
