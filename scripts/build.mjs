import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);

const entryPoints = [
  ["src/entry/cli.ts", "dist/cli.mjs", "dist/cli-meta.json"],
  ["src/entry/runtime.ts", "dist/runtime.mjs", "dist/runtime-meta.json"],
  ["src/client/index.ts", "dist/client.mjs", "dist/client-meta.json"],
  [
    "src/store/journal-sqlite-worker.ts",
    "dist/journal-sqlite-worker.mjs",
    "dist/journal-sqlite-worker-meta.json",
  ],
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

await execFileAsync(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "--project",
  "tsconfig.client.json",
]);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const files = [];
const artifactPaths = [...(await listFiles("dist")), ...(await listFiles("bin")), "package.json"];
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
      schemaVersion: 4,
      package: { name: packageJson.name, version: packageJson.version },
      piRuntime: { mode: "external" },
      runtime: packageJson.pifleet,
      files,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

async function listFiles(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths.sort();
}
