import type { Readable, Writable } from "node:stream";

import type { FleetClient, OperationIdentity } from "../client/fleet-client.js";

export interface CliDependencies {
  readonly client: FleetClient;
  readonly cwd: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly signal: AbortSignal;
  readonly operationIds: () => OperationIdentity;
}

export interface CommandContext extends CliDependencies {
  readonly piArgv: readonly string[];
}
