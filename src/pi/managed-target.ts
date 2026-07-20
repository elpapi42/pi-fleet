import { fileURLToPath } from "node:url";

import type { RealPiLauncherOptions } from "./adapter.js";

export function resolveManagedPiTarget(
  env: NodeJS.ProcessEnv = process.env,
): RealPiLauncherOptions {
  const external = env.PIFLEET_PI_EXECUTABLE;
  if (external !== undefined) {
    return {
      executable: external,
      artifactId: env.PIFLEET_PI_ARTIFACT_ID ?? "external-pi",
    };
  }

  return {
    executable: process.execPath,
    argvPrefix: [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))],
    artifactId: "@earendil-works/pi-coding-agent@0.80.10",
  };
}
