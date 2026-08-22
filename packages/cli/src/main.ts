#!/usr/bin/env node
import { connectPiFleet, version } from "@elpapi42/pi-fleet-sdk"

const usage = `pi-fleet CLI ${version}

Usage:
  pif create NAME [INSTRUCTIONS] [--cwd PATH] [-- PI_ARGS...]
  pif status NAME
  pif list
  pif --help`

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(usage)
    return
  }

  const client = await connectPiFleet()
  try {
    switch (args[0]) {
      case "create": {
        const [name, ...remaining] = args.slice(1)
        if (!name) throw new Error("Usage: pif create NAME [INSTRUCTIONS] [--cwd PATH] [-- PI_ARGS...]")
        const instructions = remaining[0] && !remaining[0].startsWith("--") ? remaining.shift() : undefined
        const separator = remaining.indexOf("--")
        const options = separator < 0 ? remaining : remaining.slice(0, separator)
        const piArgs = separator < 0 ? [] : remaining.slice(separator + 1)
        const cwdIndex = options.indexOf("--cwd")
        if (cwdIndex >= 0 && (cwdIndex + 1 >= options.length || options.length !== 2)) {
          throw new Error("Usage: pif create NAME [INSTRUCTIONS] [--cwd PATH] [-- PI_ARGS...]")
        }
        if (cwdIndex < 0 && options.length !== 0) throw new Error("Usage: pif create NAME [INSTRUCTIONS] [--cwd PATH] [-- PI_ARGS...]")
        const cwd = cwdIndex < 0 ? process.cwd() : options[cwdIndex + 1]
        const agent = await client.create({ name, instructions, cwd, piArgs })
        console.log(JSON.stringify({ id: agent.id, name: agent.name }))
        return
      }
      case "status": {
        const name = args[1]
        if (!name || args.length !== 2) throw new Error("Usage: pif status NAME")
        console.log(JSON.stringify(await (await client.get(name)).status()))
        return
      }
      case "list":
        if (args.length !== 1) throw new Error("Usage: pif list")
        for (const agent of await client.list()) console.log(JSON.stringify(agent))
        return
      default:
        throw new Error(`Unknown command: ${args[0]}`)
    }
  } finally {
    await client.close()
  }
}

void main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ error: message })}\n`)
  process.exitCode = 1
})
