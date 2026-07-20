import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CommanderError } from "commander";

import { splitArgv } from "../cli/argv.js";
import type { CliDependencies as Dependencies } from "../cli/context.js";
import { createProgram } from "../cli/program.js";
import { writeError } from "../cli/output.js";
import { SocketFleetClient } from "../client/socket-fleet-client.js";
import { ensureRuntime } from "../platform/client/start-runtime.js";
import { resolveFleetPaths } from "../platform/shared/paths.js";

export type CliDependencies = Dependencies;

function defaultDependencies(): CliDependencies {
  const abort = new AbortController();
  const paths = resolveFleetPaths();
  return {
    client: new SocketFleetClient({
      socketPath: paths.socketPath,
      beforeConnect: () => ensureRuntime({ socketPath: paths.socketPath, env: process.env }),
    }),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: abort.signal,
    operationIds: () => ({ operationId: randomUUID(), createdAt: new Date().toISOString() }),
  };
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = defaultDependencies(),
): Promise<number> {
  const split = splitArgv(argv);
  const commandName = split.fleetArgv[0];
  const human = commandName !== "watch" && split.fleetArgv.includes("--human");

  if (split.piArgv.length > 0 && commandName !== "create") {
    writeError(
      dependencies.stderr,
      { code: "invalid_arguments", message: "Only create accepts Pi arguments after --." },
      human,
    );
    return 1;
  }

  let exitCode = 0;
  const program = createProgram({ ...dependencies, piArgv: split.piArgv }, (value) => {
    exitCode = value;
  });

  if (split.fleetArgv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...split.fleetArgv], { from: "user" });
    return exitCode;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      writeError(
        dependencies.stderr,
        { code: "invalid_arguments", message: error.message.replace(/^error:\s*/i, "") },
        human,
      );
      return 1;
    }
    const message = error instanceof Error ? error.message : "Unexpected CLI error";
    writeError(dependencies.stderr, { code: "invalid_arguments", message }, human);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
