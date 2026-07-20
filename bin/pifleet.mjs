#!/usr/bin/env node

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = (major === 22 && minor >= 19) || major === 24;

if (!supported) {
  process.stderr.write(
    `pifleet requires Node ^22.19.0 or ^24.0.0; found ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  process.stderr.write("pifleet is not implemented yet.\n");
  process.exitCode = 1;
}
