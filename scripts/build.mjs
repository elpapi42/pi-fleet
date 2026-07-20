import { rm, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const entryPoints = [
  ["src/entry/cli.ts", "dist/cli.mjs", "dist/cli-meta.json"],
  ["src/entry/runtime.ts", "dist/runtime.mjs", "dist/runtime-meta.json"],
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

  await writeFile(metafile, JSON.stringify(result.metafile, null, 2) + "\n");
}
