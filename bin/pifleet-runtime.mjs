#!/usr/bin/env node

const minimumNode22Minor = 19;
const [major, minor] = process.versions.node.split(".").map(Number);
const isSupported = (major === 22 && minor >= minimumNode22Minor) || major === 24;

if (!isSupported) {
  process.stderr.write(
    `Pi Fleet runtime requires Node ^22.19.0 or ^24.0.0; found ${process.versions.node}. Run the installer repair operation with a supported Node executable.\n`,
  );
  process.exitCode = 1;
} else {
  const runtime = await import("../dist/runtime.mjs");
  await runtime.runRuntime();
}
