import { pathToFileURL } from "node:url";

import { RealPiLauncher } from "../pi/adapter.js";
import { resolveManagedPiTarget } from "../pi/managed-target.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";
import { startControlServer } from "../runtime/control-server.js";
import { FleetService } from "../runtime/fleet-service.js";
import { WorkerFleetStore } from "../store/worker-store.js";

export async function runRuntime(): Promise<void> {
  const paths = resolveFleetPaths();
  let resolveService: (service: FleetService) => void;
  let rejectService: (error: unknown) => void;
  const serviceReady = new Promise<FleetService>((resolveReady, rejectReady) => {
    resolveService = resolveReady;
    rejectService = rejectReady;
  });
  const server = await startControlServer({ socketPath: paths.socketPath, service: serviceReady });

  let store: WorkerFleetStore;
  let service: FleetService;
  try {
    store = new WorkerFleetStore(paths.databasePath);
    service = new FleetService(store, {
      launcher: new RealPiLauncher(resolveManagedPiTarget()),
    });
    await service.reconcile();
    resolveService!(service);
  } catch (error: unknown) {
    rejectService!(error);
    await server.close();
    throw error;
  }

  await new Promise<void>((resolveShutdown) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void server
        .close()
        .then(() => service.close())
        .then(() => store.close(true))
        .finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRuntime();
}
