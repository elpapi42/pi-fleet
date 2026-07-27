import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("one-package client contract", () => {
  it("publishes a client-only ESM subpath with generated declarations", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    expect(packageJson.exports?.["./client"]).toEqual({
      types: "./dist/client/index.d.ts",
      import: "./dist/client.mjs",
    });

    const metadata = JSON.parse(await readFile("dist/client-meta.json", "utf8")) as {
      inputs: Record<string, unknown>;
    };
    const inputs = Object.keys(metadata.inputs);
    expect(
      inputs.some((path) => path.includes("/runtime/") || path.startsWith("src/runtime/")),
    ).toBe(false);
    expect(inputs.some((path) => path.includes("/store/") || path.startsWith("src/store/"))).toBe(
      false,
    );
    expect(
      inputs.some((path) => path.includes("/pi/process") || path.includes("/pi/adapter")),
    ).toBe(false);

    const declaration = await readFile("dist/client/index.d.ts", "utf8");
    expect(declaration).not.toMatch(/(?:\.\.\/)+(?:runtime|store|pi)\//);
    await expect(readFile("dist/client/sdk-facade.d.ts", "utf8")).resolves.toContain(
      "interface PiFleetClient",
    );
    await expect(readFile("dist/client/contracts.d.ts", "utf8")).resolves.toContain(
      "SemanticEvent",
    );
    await expect(readFile("dist/client/index.d.ts.map", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const runtimeManifest = JSON.parse(await readFile("dist/runtime-manifest.json", "utf8")) as {
      runtime?: {
        protocolVersion?: number;
        journalSchemaVersion?: number;
        clientExport?: string;
      };
      files: Array<{ path: string }>;
    };
    expect(runtimeManifest.runtime).toEqual({
      protocolVersion: 3,
      journalSchemaVersion: 3,
      clientExport: "./client",
    });
    expect(runtimeManifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "dist/client.mjs",
        "dist/client/index.d.ts",
        "dist/client/sdk-facade.d.ts",
        "dist/client/contracts.d.ts",
        "dist/journal-sqlite-worker.mjs",
      ]),
    );

    const imported = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      "const m = await import('@elpapi42/pi-fleet/client'); if (typeof m.connectPiFleet !== 'function') process.exit(1);",
    ]);
    expect(imported.stderr).toBe("");
  });
});
