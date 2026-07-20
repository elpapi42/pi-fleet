import { pathToFileURL } from "node:url";

import { RealPiLauncher } from "../pi/adapter.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";
import { startControlServer } from "../runtime/control-server.js";
import { FleetService } from "../runtime/fleet-service.js";
import { MemoryFleetStore } from "../store/memory-store.js";

export async function runRuntime(): Promise<void> {
  const paths = resolveFleetPaths();
  const service = new FleetService(new MemoryFleetStore(), {
    launcher: new RealPiLauncher({
      executable: process.env.PIFLEET_PI_EXECUTABLE ?? "pi",
      artifactId: process.env.PIFLEET_PI_ARTIFACT_ID ?? "pi@0.80.10",
    }),
  });
  const server = await startControlServer({ socketPath: paths.socketPath, service });

  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void server
        .close()
        .then(() => service.close())
        .finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRuntime();
}
