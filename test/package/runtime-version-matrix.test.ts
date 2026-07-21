import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCompatibilityEnvironment,
  installReleasedPackage,
  invokeJsonError,
  invokeList,
  pathExists,
  removeCompatibilityRoot,
  socketInode,
  startRuntime,
  type PackageArtifacts,
} from "../helpers/package-version-harness.js";

const RELEASED_VERSIONS = ["0.1.0-beta.0", "0.1.0-beta.1"] as const;

interface CompatibilityCase {
  readonly name: string;
  readonly cli: () => PackageArtifacts;
  readonly runtime: () => PackageArtifacts;
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "released CLI/runtime protocol compatibility",
  () => {
    let suiteRoot = "";
    let beta0: PackageArtifacts;
    let beta1: PackageArtifacts;
    const current: PackageArtifacts = {
      label: "current",
      cliPath: resolve("bin/pifleet.mjs"),
      runtimePath: resolve("dist/runtime.mjs"),
    };

    beforeAll(async () => {
      suiteRoot = await mkdtemp(join(tmpdir(), "pifleet-version-matrix-"));
      const installed = await Promise.all(
        RELEASED_VERSIONS.map((version) =>
          installReleasedPackage(version, join(suiteRoot, "packages", version)),
        ),
      );
      const installedBeta0 = installed[0];
      const installedBeta1 = installed[1];
      if (installedBeta0 === undefined || installedBeta1 === undefined) {
        throw new Error("Released package installation did not return both beta artifacts");
      }
      beta0 = installedBeta0;
      beta1 = installedBeta1;
    }, 180_000);

    afterAll(async () => {
      if (suiteRoot !== "") await removeCompatibilityRoot(suiteRoot);
    });

    const cases: readonly CompatibilityCase[] = [
      {
        name: "beta.0 CLI communicates with a beta.1 runtime",
        cli: () => beta0,
        runtime: () => beta1,
      },
      {
        name: "beta.1 CLI communicates with a beta.0 runtime",
        cli: () => beta1,
        runtime: () => beta0,
      },
      {
        name: "current CLI communicates with a beta.0 runtime",
        cli: () => current,
        runtime: () => beta0,
      },
      {
        name: "current CLI communicates with a beta.1 runtime",
        cli: () => current,
        runtime: () => beta1,
      },
    ];

    it("fails compact explicitly against an older runtime without replacing it", async () => {
      const caseRoot = await mkdtemp(join(suiteRoot, "compact-skew-"));
      const environment = await createCompatibilityEnvironment(caseRoot);
      const running = await startRuntime(beta1, environment);
      try {
        const inodeBefore = await socketInode(environment.socketPath);
        const error = await invokeJsonError(current, ["compact", "reviewer"], environment);
        const inodeAfter = await socketInode(environment.socketPath);

        expect(error).toMatchObject({
          schemaVersion: 1,
          type: "error",
          error: { code: "protocol_incompatible" },
        });
        expect(inodeAfter).toBe(inodeBefore);
        expect(() => process.kill(running.pid, 0)).not.toThrow();
        expect(await pathExists(environment.applicationRoot)).toBe(false);
      } finally {
        await running.stop();
        await removeCompatibilityRoot(caseRoot);
      }
    }, 60_000);

    it.each(cases)(
      "$name without replacing the active runtime",
      async ({ cli, runtime }) => {
        const caseRoot = await mkdtemp(join(suiteRoot, "case-"));
        const environment = await createCompatibilityEnvironment(caseRoot);
        const running = await startRuntime(runtime(), environment);
        try {
          const inodeBefore = await socketInode(environment.socketPath);
          const result = await invokeList(cli(), environment);
          const inodeAfter = await socketInode(environment.socketPath);

          expect(result).toMatchObject({
            schemaVersion: 1,
            type: "agent.list",
            agents: [],
          });
          expect(inodeAfter).toBe(inodeBefore);
          expect(() => process.kill(running.pid, 0)).not.toThrow();
          expect(await pathExists(environment.applicationRoot)).toBe(false);
        } finally {
          await running.stop();
          await removeCompatibilityRoot(caseRoot);
        }
      },
      60_000,
    );
  },
);
