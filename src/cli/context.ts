import type { Readable, Writable } from "node:stream";

import type { PiFleetClient } from "../client/sdk-facade.js";

export interface CliDependencies {
  readonly client: PiFleetClient;
  readonly cwd: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly signal: AbortSignal;
}

export interface CommandContext extends CliDependencies {
  readonly piArgv: readonly string[];
}
