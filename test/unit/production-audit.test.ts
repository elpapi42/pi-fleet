import { describe, expect, it } from "vitest";

// The release policy intentionally lives in a plain Node.js script used directly by CI.
// @ts-expect-error The JavaScript release script does not publish TypeScript declarations.
import { validateProductionAudit } from "../../scripts/check-production-audit.mjs";

const cleanReport = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
  vulnerabilities: {},
};

describe("production audit policy", () => {
  it("requires a clean production audit without exceptions", () => {
    expect(validateProductionAudit(cleanReport)).toEqual({ exceptionUsed: false });
  });

  it("rejects any production vulnerability", () => {
    expect(() =>
      validateProductionAudit({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
        },
        vulnerabilities: { dependency: { severity: "moderate" } },
      }),
    ).toThrow(/zero vulnerabilities/i);
  });

  it("rejects malformed audit reports", () => {
    expect(() => validateProductionAudit({})).toThrow(/zero vulnerabilities/i);
  });

  it("rejects contradictory summary totals and detailed vulnerabilities", () => {
    expect(() =>
      validateProductionAudit({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        },
        vulnerabilities: { dependency: { severity: "high" } },
      }),
    ).toThrow(/zero vulnerabilities/i);
  });

  it("rejects nonzero or malformed severity counts even when total is zero", () => {
    expect(() =>
      validateProductionAudit({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 0 },
        },
        vulnerabilities: {},
      }),
    ).toThrow(/zero vulnerabilities/i);
    expect(() =>
      validateProductionAudit({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: "0" },
        },
        vulnerabilities: {},
      }),
    ).toThrow(/zero vulnerabilities/i);
  });
});
