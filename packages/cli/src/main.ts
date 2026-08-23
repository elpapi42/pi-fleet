#!/usr/bin/env node
import { Command } from "commander"
import { connectPiFleet } from "@elpapi42/pi-fleet-sdk"

const version = "0.4.0"

function splitPiArgs(args: string[]): { pifArgs: string[]; piArgs: string[] } {
  const separator = args.indexOf("--")
  if (separator < 0) return { pifArgs: args, piArgs: [] }
  return {
    pifArgs: args.slice(0, separator),
    piArgs: args.slice(separator + 1),
  }
}

function printAgent(id: string, name: string, state: string): void {
  console.log(`ID: ${id}`)
  console.log(`Name: ${name}`)
  console.log(`State: ${state}`)
}

function printAgentList(agents: Array<{ id: string; name: string; state: string }>): void {
  if (agents.length === 0) {
    console.log("No agents.")
    return
  }

  const sorted = [...agents].sort((left, right) => left.name.localeCompare(right.name))
  const nameWidth = Math.max("NAME".length, ...sorted.map((agent) => agent.name.length))
  const stateWidth = Math.max("STATE".length, ...sorted.map((agent) => agent.state.length))
  console.log(`${"NAME".padEnd(nameWidth)}  ${"STATE".padEnd(stateWidth)}  ID`)
  for (const agent of sorted) {
    console.log(`${agent.name.padEnd(nameWidth)}  ${agent.state.padEnd(stateWidth)}  ${agent.id}`)
  }
}

async function withClient<T>(action: (client: Awaited<ReturnType<typeof connectPiFleet>>) => Promise<T>): Promise<T> {
  const client = await connectPiFleet()
  try {
    return await action(client)
  } finally {
    await client.close()
  }
}

function createProgram(piArgs: string[]): Command {
  const program = new Command()

  program
    .name("pif")
    .description("Manage durable, host-local Pi agents")
    .version(version)
    .showSuggestionAfterError()
    .showHelpAfterError()

  program
    .command("create <name> [instructions]")
    .description("Create a durable Pi agent")
    .option("--cwd <path>", "working directory", process.cwd())
    .addHelpText("after", "\nArguments after -- pass through to Pi.")
    .action(async (name: string, instructions: string | undefined, options: { cwd: string }) => {
      const agent = await withClient((client) => client.create({ name, instructions, cwd: options.cwd, piArgs }))
      console.log(`Created agent ${agent.name}`)
      printAgent(agent.id, agent.name, "idle")
    })

  program
    .command("send <name> <message>")
    .description("Send work to a durable Pi agent")
    .option("--follow-up", "deliver after the current work finishes")
    .action(async (name: string, message: string, options: { followUp?: boolean }) => {
      const delivery = options.followUp ? "followUp" : "steer"
      await withClient(async (client) => (await client.get(name)).send(message, { delivery }))
      console.log(`Instruction accepted by ${name}`)
      console.log(`Delivery: ${delivery}`)
    })

  program
    .command("status <name>")
    .description("Show an agent's current state")
    .action(async (name: string) => {
      const status = await withClient(async (client) => (await client.get(name)).status())
      printAgent(status.id, status.name, status.state)
    })

  program
    .command("list")
    .description("List durable Pi agents")
    .action(async () => {
      printAgentList(await withClient((client) => client.list()))
    })

  return program
}

async function main(args: string[]): Promise<void> {
  const { pifArgs, piArgs } = splitPiArgs(args)
  const program = createProgram(piArgs)
  if (piArgs.length > 0 && pifArgs[0] !== "create") {
    program.error("Arguments after -- are supported only by pif create")
  }

  if (pifArgs.length === 0) {
    program.help()
    return
  }
  await program.parseAsync(["node", "pif", ...pifArgs])
}

void main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
