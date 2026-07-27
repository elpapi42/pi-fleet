import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as clientEntry from "../../src/client/index.js";
import {
  PiFleetError,
  connectPiFleet,
  type Agent,
  type PiFleetClient,
} from "../../src/client/index.js";

describe("client-only source entry", () => {
  it("exports only supported values and connect-only mode performs no filesystem work", async () => {
    const stateRoot = join(tmpdir(), `pifleet-sdk-entry-${randomUUID()}`);
    expect(existsSync(stateRoot)).toBe(false);
    expect(typeof connectPiFleet).toBe("function");
    expect(typeof PiFleetError).toBe("function");
    expect("PiFleetClient" in clientEntry).toBe(false);
    expect("Agent" in clientEntry).toBe(false);

    // Connecting is the explicit reachability boundary, so an absent runtime fails
    // here instead of returning a handle that only fails on first use.
    await expect(connectPiFleet({ stateRoot, autoStartRuntime: false })).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(existsSync(stateRoot)).toBe(false);

    const typedClient: PiFleetClient | undefined = undefined;
    expect(typedClient).toBeUndefined();
  });

  it("keeps Agent construction out of the public runtime surface", () => {
    const useAgent = (agent: Agent) => agent.id;
    expect(typeof useAgent).toBe("function");
  });
});
