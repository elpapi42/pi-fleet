import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const manifest = JSON.parse(await readFile("package.json", "utf8"));

if (manifest.private === true) throw new Error("package.json is still private");
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(manifest.version)) {
  throw new Error(`Refusing non-beta release version ${manifest.version}`);
}
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.tag !== "beta") {
  throw new Error("publishConfig must force public beta publication");
}
if (manifest.bin?.pifleet !== "bin/pifleet.mjs") {
  throw new Error("The npm-safe pifleet bin path is missing");
}

const identity = await readFile("src/shared/product-identity.ts", "utf8");
if (!identity.includes(`PRODUCT_VERSION = "${manifest.version}"`)) {
  throw new Error("Product and package versions differ");
}

const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"]);
const report = JSON.parse(stdout)[0];
const paths = new Set(report.files.map((file) => file.path));
for (const required of [
  "bin/pifleet.mjs",
  "bin/pifleet-runtime.mjs",
  "dist/cli.mjs",
  "dist/runtime.mjs",
  "dist/sqlite-worker.mjs",
  "dist/runtime-manifest.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
]) {
  if (!paths.has(required)) throw new Error(`Packed beta is missing ${required}`);
}
for (const path of paths) {
  if (
    path.startsWith("research/") ||
    path.startsWith("pi/") ||
    path.startsWith("herdr/") ||
    path.endsWith("PROPOSAL.md")
  ) {
    throw new Error(`Packed beta contains private development artifact ${path}`);
  }
}

process.stdout.write(
  `${manifest.name}@${manifest.version}: ${String(report.entryCount)} files, beta package checks passed\n`,
);
