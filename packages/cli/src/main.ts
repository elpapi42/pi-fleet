#!/usr/bin/env node

import { version } from "@elpapi42/pi-fleet-sdk"

const usage = `pi-fleet CLI ${version}

Usage:
  pif --help

Commands will be added with Slice 1.`

export function run(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`)
    return 0
  }

  process.stderr.write(`Unknown argument: ${args[0]}\nRun pif --help for usage.\n`)
  return 1
}

process.exitCode = run(process.argv.slice(2))
