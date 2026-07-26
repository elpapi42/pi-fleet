import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const SEVERITY_KEYS = ["info", "low", "moderate", "high", "critical", "total"];

export function validateProductionAudit(report) {
  const totals = report?.metadata?.vulnerabilities;
  const vulnerabilities = report?.vulnerabilities;
  const zeroCount = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value === 0;
  if (
    typeof totals !== "object" ||
    totals === null ||
    Array.isArray(totals) ||
    typeof vulnerabilities !== "object" ||
    vulnerabilities === null ||
    Array.isArray(vulnerabilities) ||
    Object.keys(vulnerabilities).length !== 0 ||
    !SEVERITY_KEYS.every((key) => zeroCount(totals[key])) ||
    !Object.values(totals).every(zeroCount)
  ) {
    throw new Error("Production audit must contain zero vulnerabilities");
  }
  return { exceptionUsed: false };
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
  validateProductionAudit(JSON.parse(stdout));
  process.stdout.write("Production dependency audit passed with no vulnerabilities.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
