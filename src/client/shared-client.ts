import { randomUUID } from "node:crypto";

import {
  installationIdentity,
  resolveExternalPiInstallation,
} from "../pi/external-installation.js";
import { assertRegisteredPiSelection, ensureRuntime } from "../platform/client/start-runtime.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";
import type { FleetClient, OperationIdentity } from "./fleet-client.js";
import { SocketFleetClient } from "./socket-fleet-client.js";

export interface SharedClientConnectionOptions {
  readonly stateRoot?: string;
  readonly applicationRoot?: string;
  readonly autoStartRuntime: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SharedClientConnection {
  readonly client: FleetClient;
  readonly operationIds: () => OperationIdentity;
  readonly ensureControlPlane: () => Promise<void>;
  readonly selectPiForMutation: () => Promise<unknown>;
}

/**
 * Creates the common CLI/SDK private client graph without performing I/O.
 * Runtime discovery and Pi selection remain lazy explicit operations.
 */
export function createSharedClientConnection(
  options: SharedClientConnectionOptions,
): SharedClientConnection {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    ...(options.stateRoot === undefined ? {} : { PIFLEET_STATE_ROOT: options.stateRoot }),
  };
  const paths = resolveFleetPaths(env);
  let installation: ReturnType<typeof resolveExternalPiInstallation> | undefined;
  const selectedPi = () => (installation ??= resolveExternalPiInstallation({ env }));
  const selectPiForMutation = async () => {
    const selected = await selectedPi();
    if (env.PIFLEET_DISABLE_REGISTERED_SERVICE !== "1") {
      await assertRegisteredPiSelection({
        selectedPath: selected.selectedPath,
        nodePath: selected.nodePath,
      });
    }
    return selected;
  };
  const ensureControlPlane = () =>
    ensureRuntime({
      socketPath: paths.socketPath,
      env,
      ...(options.applicationRoot === undefined
        ? {}
        : { applicationRoot: options.applicationRoot }),
      piInstallation: async () => {
        try {
          return await selectedPi();
        } catch {
          // The control plane remains useful for passive operations without Pi.
          return null;
        }
      },
    });
  const client = new SocketFleetClient({
    socketPath: paths.socketPath,
    ...(options.autoStartRuntime ? { beforeConnect: ensureControlPlane } : {}),
    piIdentity: async () => installationIdentity(await selectPiForMutation()),
  });
  return {
    client,
    operationIds: () => ({
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
    ensureControlPlane,
    selectPiForMutation,
  };
}
