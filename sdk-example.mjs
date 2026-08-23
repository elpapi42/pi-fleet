#!/usr/bin/env node
import { connectPiFleet } from "@elpapi42/pi-fleet-sdk"

function printAgent({ id, name, state }) {
  console.log(`ID: ${id}`)
  console.log(`Name: ${name}`)
  console.log(`State: ${state}`)
}

function printUsage() {
  console.log(`Usage:
  npm run sdk:example -- list
  npm run sdk:example -- create NAME [INSTRUCTIONS]
  npm run sdk:example -- status NAME

Creating an agent starts a durable worker. client.close() closes only this script's SDK client; it does not stop the agent.`)
}

const [command, name, ...instructionParts] = process.argv.slice(2)

if (!command || command === "--help" || command === "-h") {
  printUsage()
} else if (!new Set(["list", "create", "status"]).has(command)) {
  console.error(`Unknown command: ${command}`)
  printUsage()
  process.exitCode = 1
} else if (command === "list" && name) {
  console.error("Usage: npm run sdk:example -- list")
  process.exitCode = 1
} else if ((command === "create" || command === "status") && !name) {
  console.error(`Usage: npm run sdk:example -- ${command} NAME${command === "create" ? " [INSTRUCTIONS]" : ""}`)
  process.exitCode = 1
} else {
  const client = await connectPiFleet()
  try {
    if (command === "list") {
      const agents = await client.list()
      if (agents.length === 0) {
        console.log("No agents.")
      } else {
        for (const agent of agents) printAgent(agent)
      }
    } else if (command === "create") {
      const agent = await client.create({
        name,
        cwd: process.cwd(),
        instructions: instructionParts.length > 0 ? instructionParts.join(" ") : undefined,
      })
      console.log(`Created agent ${agent.name}`)
      printAgent({ id: agent.id, name: agent.name, state: (await agent.status()).state })
    } else {
      const agent = await client.get(name)
      printAgent(await agent.status())
    }
  } finally {
    await client.close()
  }
}
