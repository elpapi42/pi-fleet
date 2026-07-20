import { describe, expect, it } from "vitest";

// The release policy intentionally lives in a plain Node.js script used directly by CI.
// @ts-expect-error The JavaScript release script does not publish TypeScript declarations.
import { validateProductionAudit } from "../../scripts/check-production-audit.mjs";

const installed = { piVersion: "0.80.10", braceExpansionVersion: "5.0.6" };
const allowedReport = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  },
  vulnerabilities: {
    "brace-expansion": {
      severity: "high",
      via: [{ source: 1123898, url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp" }],
      nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
    },
  },
};

describe("production audit policy", () => {
  it("passes a clean production audit without an exception", () => {
    expect(
      validateProductionAudit(
        {
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
          },
          vulnerabilities: {},
        },
        installed,
      ),
    ).toEqual({ exceptionUsed: false });
  });

  it("allows only the exact managed-Pi advisory and installed versions", () => {
    expect(validateProductionAudit(allowedReport, installed)).toEqual({ exceptionUsed: true });
  });

  it("rejects additional production vulnerabilities", () => {
    expect(() =>
      validateProductionAudit(
        {
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
          },
          vulnerabilities: {
            ...allowedReport.vulnerabilities,
            unexpected: { severity: "high", via: [], nodes: ["node_modules/unexpected"] },
          },
        },
        installed,
      ),
    ).toThrow(/outside the approved exception/i);
  });

  it("rejects a changed vulnerable dependency identity", () => {
    expect(() =>
      validateProductionAudit(allowedReport, {
        piVersion: "0.80.11",
        braceExpansionVersion: "5.0.6",
      }),
    ).toThrow(/no longer matches/i);
  });
});
