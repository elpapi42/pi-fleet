import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const ALLOWED_ADVISORY = "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp";
const ALLOWED_NODE = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";

export function validateProductionAudit(report, installed) {
  const totals = report?.metadata?.vulnerabilities;
  if (totals?.total === 0) return { exceptionUsed: false };

  const vulnerabilities = report?.vulnerabilities;
  if (
    totals?.total !== 1 ||
    totals?.high !== 1 ||
    totals?.critical !== 0 ||
    typeof vulnerabilities !== "object" ||
    vulnerabilities === null ||
    Object.keys(vulnerabilities).length !== 1
  ) {
    throw new Error("Production audit contains vulnerabilities outside the approved exception");
  }

  const vulnerability = vulnerabilities["brace-expansion"];
  const advisories = Array.isArray(vulnerability?.via)
    ? vulnerability.via.filter((entry) => typeof entry === "object" && entry !== null)
    : [];
  if (
    installed.piVersion !== "0.80.10" ||
    installed.braceExpansionVersion !== "5.0.6" ||
    vulnerability?.severity !== "high" ||
    !Array.isArray(vulnerability?.via) ||
    vulnerability.via.length !== 1 ||
    advisories.length !== 1 ||
    advisories[0].source !== 1123898 ||
    advisories[0].url !== ALLOWED_ADVISORY ||
    !Array.isArray(vulnerability?.nodes) ||
    vulnerability.nodes.length !== 1 ||
    vulnerability.nodes[0] !== ALLOWED_NODE
  ) {
    throw new Error(
      "Production audit no longer matches the narrowly approved Pi 0.80.10 exception",
    );
  }

  return { exceptionUsed: true };
}

async function main() {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)("npm", ["audit", "--omit=dev", "--json"], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("stdout" in error) ||
      typeof error.stdout !== "string"
    ) {
      throw error;
    }
    stdout = error.stdout;
  }

  const [piManifest, braceManifest] = await Promise.all([
    readFile("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"),
    readFile(
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json",
      "utf8",
    ),
  ]);
  const result = validateProductionAudit(JSON.parse(stdout), {
    piVersion: JSON.parse(piManifest).version,
    braceExpansionVersion: JSON.parse(braceManifest).version,
  });

  if (result.exceptionUsed) {
    process.stderr.write(
      `WARNING: allowing only ${ALLOWED_ADVISORY} in managed Pi 0.80.10; upstream issue: https://github.com/earendil-works/pi/issues/6882\n`,
    );
  } else {
    process.stdout.write("Production dependency audit passed with no vulnerabilities.\n");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
