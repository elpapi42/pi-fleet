import { pathToFileURL } from "node:url";

import { resolveFleetPaths } from "../platform/shared/paths.js";
import { startControlServer } from "../runtime/control-server.js";
import { FleetService } from "../runtime/fleet-service.js";
import { MemoryFleetStore } from "../store/memory-store.js";

export async function runRuntime(): Promise<void> {
  const paths = resolveFleetPaths();
  const server = await startControlServer({
    socketPath: paths.socketPath,
    service: new FleetService(new MemoryFleetStore()),
  });

  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void server.close().finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRuntime();
}
