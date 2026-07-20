import { pathToFileURL } from "node:url";

import { PRODUCT_BINARY, PRODUCT_VERSION } from "../shared/product-identity.js";

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export function runCli(argv: readonly string[], io: CliIo): number {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    io.stdout.write(`${PRODUCT_VERSION}\n`);
    return 0;
  }

  io.stderr.write(`${PRODUCT_BINARY} is not implemented yet.\n`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2), process);
}
