import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { resolveManagedPiTarget } from "../../src/pi/managed-target.js";

describe("managed Pi target", () => {
  it("resolves the pinned package RPC entrypoint by default", async () => {
    const target = resolveManagedPiTarget({});

    expect(target.executable).toBe(process.execPath);
    expect(target.artifactId).toBe("@earendil-works/pi-coding-agent@0.80.10");
    expect(target.argvPrefix).toHaveLength(1);
    await expect(access(target.argvPrefix![0]!)).resolves.toBeUndefined();
  });

  it("allows an explicit development target without changing public Pi argv", () => {
    expect(
      resolveManagedPiTarget({ PIFLEET_PI_EXECUTABLE: "/tmp/pi", PIFLEET_PI_ARTIFACT_ID: "dev" }),
    ).toEqual({ executable: "/tmp/pi", artifactId: "dev" });
  });
});
