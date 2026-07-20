export interface SplitArgv {
  readonly fleetArgv: readonly string[];
  readonly piArgv: readonly string[];
  readonly hadSeparator: boolean;
}

export function splitArgv(argv: readonly string[]): SplitArgv {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    return { fleetArgv: [...argv], piArgv: [], hadSeparator: false };
  }
  return {
    fleetArgv: argv.slice(0, separator),
    piArgv: argv.slice(separator + 1),
    hadSeparator: true,
  };
}
