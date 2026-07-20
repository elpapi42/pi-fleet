#!/usr/bin/env node

const minimumNode22Minor = 19;
const [major, minor] = process.versions.node.split(".").map(Number);
const isSupported = (major === 22 && minor >= minimumNode22Minor) || major === 24;

if (!isSupported) {
  process.stderr.write(
    `pifleet requires Node ^22.19.0 or ^24.0.0; found ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  const cli = await import("../dist/cli.mjs");
  process.exitCode = cli.runCli(process.argv.slice(2), process);
}
