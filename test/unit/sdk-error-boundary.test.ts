import { describe, expect, it } from "vitest";

import { PiFleetError } from "../../src/client/index.js";

describe("PiFleetError public boundary", () => {
  it("redacts Node errors and structural lookalikes", () => {
    const nodeError = Object.assign(new Error("ENOENT: /private/state"), {
      code: "ENOENT",
      details: { path: "/private/state" },
    });

    for (const error of [
      nodeError,
      {
        code: "storage_unavailable",
        message: "raw internal message",
        details: { secret: "raw retained data" },
      },
    ]) {
      expect(PiFleetError.from(error)).toEqual(
        new PiFleetError("internal_error", "pi-fleet client operation failed"),
      );
    }
  });

  it("preserves explicitly created public pi-fleet errors", () => {
    const error = new PiFleetError("storage_unavailable", "Storage is unavailable.", {
      retryAfterMs: 1,
    });

    expect(PiFleetError.from(error)).toBe(error);
  });
});
