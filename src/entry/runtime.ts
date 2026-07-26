import { pathToFileURL } from "node:url";

import { createExternalPiTarget } from "../pi/external-target.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";
import { startControlServer } from "../runtime/control-server.js";
import { FleetService } from "../runtime/fleet-service.js";
import { runtimeLimitsFromEnv } from "../shared/runtime-limits.js";
import { WorkerFleetStore } from "../store/worker-store.js";

export async function runRuntime(): Promise<void> {
  const paths = resolveFleetPaths();
  const limits = runtimeLimitsFromEnv();
  let resolveService: (service: FleetService) => void;
  let rejectService: (error: unknown) => void;
  const serviceReady = new Promise<FleetService>((resolveReady, rejectReady) => {
    resolveService = resolveReady;
    rejectService = rejectReady;
  });
  const server = await startControlServer({
    socketPath: paths.socketPath,
    service: serviceReady,
    limits,
  });

  let store: WorkerFleetStore;
  let service: FleetService;
  try {
    store = new WorkerFleetStore(paths.databasePath);
    const piTarget = await createExternalPiTarget(process.env, limits.maxPiFrameBytes);
    service = new FleetService(store, {
      launcher: piTarget.launcher,
      piIdentity: piTarget.identity,
      limits,
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
      const serviceClosing = service.close();
      const serverClosing = server.close();
      void Promise.allSettled([serviceClosing, serverClosing])
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
