import { describe, expect, it } from "vitest";

import { isSupportedNodeVersion } from "../../src/shared/node-version.js";

describe("isSupportedNodeVersion", () => {
  it("accepts Node 22.19 and later Node 22 releases", () => {
    expect(isSupportedNodeVersion("22.19.0")).toBe(true);
    expect(isSupportedNodeVersion("22.20.1")).toBe(true);
  });

  it("accepts Node 24 but rejects unsupported majors and old Node 22", () => {
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("22.18.9")).toBe(false);
    expect(isSupportedNodeVersion("23.0.0")).toBe(false);
    expect(isSupportedNodeVersion("25.0.0")).toBe(false);
  });
});
