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
if (
  manifest.exports?.["./client"]?.types !== "./dist/client/index.d.ts" ||
  manifest.exports?.["./client"]?.import !== "./dist/client.mjs"
) {
  throw new Error("The @elpapi42/pi-fleet/client export is missing or mismatched");
}
if (manifest.dependencies?.["@earendil-works/pi-coding-agent"] !== undefined) {
  throw new Error("pi-fleet must not package a managed Pi runtime");
}
if (
  manifest.pifleet?.protocolVersion !== 3 ||
  manifest.pifleet?.journalSchemaVersion !== 3 ||
  manifest.pifleet?.clientExport !== "./client"
) {
  throw new Error("package.json has mismatched protocol, journal, or client identity");
}

const identity = await readFile("src/shared/product-identity.ts", "utf8");
if (!identity.includes(`PRODUCT_VERSION = "${manifest.version}"`)) {
  throw new Error("Product and package versions differ");
}
const protocol = await readFile("src/protocol/version.ts", "utf8");
const journal = await readFile("src/store/sqlite-journal-store.ts", "utf8");
if (!protocol.includes(`PROTOCOL_VERSION = ${String(manifest.pifleet.protocolVersion)}`)) {
  throw new Error("Package and protocol versions differ");
}
if (
  !journal.includes(`JOURNAL_SCHEMA_VERSION = ${String(manifest.pifleet.journalSchemaVersion)}`)
) {
  throw new Error("Package and journal schema versions differ");
}
const runtimeManifest = JSON.parse(await readFile("dist/runtime-manifest.json", "utf8"));
if (
  runtimeManifest.schemaVersion !== 4 ||
  runtimeManifest.runtime?.protocolVersion !== manifest.pifleet.protocolVersion ||
  runtimeManifest.runtime?.journalSchemaVersion !== manifest.pifleet.journalSchemaVersion ||
  runtimeManifest.runtime?.clientExport !== manifest.pifleet.clientExport
) {
  throw new Error("Runtime manifest protocol, journal, or client identity is mismatched");
}
const runtimeFiles = new Set(runtimeManifest.files?.map((file) => file.path) ?? []);
for (const required of [
  "dist/client.mjs",
  "dist/client/index.d.ts",
  "dist/client/sdk-facade.d.ts",
  "dist/client/contracts.d.ts",
  "dist/runtime.mjs",
]) {
  if (!runtimeFiles.has(required)) {
    throw new Error(`Runtime manifest is missing matching artifact ${required}`);
  }
}

const clientMetadata = JSON.parse(await readFile("dist/client-meta.json", "utf8"));
for (const input of Object.keys(clientMetadata.inputs ?? {})) {
  if (
    input.startsWith("src/runtime/") ||
    input.startsWith("src/store/") ||
    input === "src/pi/process.ts" ||
    input === "src/pi/adapter.ts"
  ) {
    throw new Error(`Client bundle contains private execution graph ${input}`);
  }
}

const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"]);
const report = JSON.parse(stdout)[0];
const paths = new Set(report.files.map((file) => file.path));
for (const required of [
  "bin/pifleet.mjs",
  "bin/pifleet-runtime.mjs",
  "dist/cli.mjs",
  "dist/runtime.mjs",
  "dist/journal-sqlite-worker.mjs",
  "dist/client.mjs",
  "dist/client-meta.json",
  "dist/client/index.d.ts",
  "dist/client/sdk-facade.d.ts",
  "dist/client/contracts.d.ts",
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
