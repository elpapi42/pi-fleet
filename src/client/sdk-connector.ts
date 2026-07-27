import {
  PiFleetError,
  type ConnectPiFleetOptions,
  type SdkConnector,
  type SdkTransport,
} from "./sdk-facade.js";
import {
  createSharedClientConnection,
  type SharedClientConnection,
  type SharedClientConnectionOptions,
} from "./shared-client.js";
import { FleetClientSdkTransport } from "./sdk-transport.js";

export interface SdkConnectorDependencies {
  readonly createConnection?: (options: SharedClientConnectionOptions) => SharedClientConnection;
}

/** Creates the concrete connector while preserving side-effect-free module evaluation. */
export function createSdkConnector(dependencies: SdkConnectorDependencies = {}): SdkConnector {
  const createConnection = dependencies.createConnection ?? createSharedClientConnection;
  return {
    async connect(options: ConnectPiFleetOptions): Promise<SdkTransport> {
      throwIfConnectionAborted(options.signal);
      const connection = createConnection({
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        ...(options.applicationRoot === undefined
          ? {}
          : { applicationRoot: options.applicationRoot }),
        autoStartRuntime: options.autoStartRuntime !== false,
      });
      if (options.autoStartRuntime !== false) {
        try {
          await waitForLocalCompletion(connection.ensureControlPlane(), options.signal);
        } catch (error: unknown) {
          throw PiFleetError.from(error);
        }
      }
      throwIfConnectionAborted(options.signal);
      // Connecting must prove the shared control plane is reachable and speaks this
      // protocol major before any handle is returned. `list` is the smallest passive
      // request, so it never resolves Pi or wakes an agent.
      const reachable = await waitForLocalCompletion(
        connection.client.list({ signal: options.signal ?? new AbortController().signal }),
        options.signal,
      );
      if (!reachable.ok) throw new PiFleetError(reachable.error.code, reachable.error.message);
      return new FleetClientSdkTransport(connection.client, connection.operationIds);
    },
  };
}

function throwIfConnectionAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new PiFleetError("cancelled", "Connection cancelled.");
  }
}

function waitForLocalCompletion<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfConnectionAborted(signal);
  if (signal === undefined) return operation;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new PiFleetError("cancelled", "Connection cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
