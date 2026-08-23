#!/usr/bin/env node
import { Command } from "commander"
import { connectPiFleet, type AgentEvent } from "@elpapi42/pi-fleet-sdk"

const version = "0.7.0"

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

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncateUtf8(value: string, maxBytes = 8 * 1024): { value: string; truncated: boolean } {
  let bytes = 0
  const characters: string[] = []
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) return { value: characters.join(""), truncated: true }
    characters.push(character)
    bytes += characterBytes
  }
  return { value, truncated: false }
}

function printValue(label: string, value: unknown): void {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = "[unavailable]"
  }
  const bounded = truncateUtf8(text)
  console.log(`  ${label}: ${bounded.value}${bounded.truncated ? " [truncated]" : ""}`)
}

function printOutput(event: Extract<AgentEvent, { type: "tool.finished" }>): void {
  for (const part of event.output.content) {
    if (part.type === "text") {
      const bounded = truncateUtf8(part.text)
      console.log(`  Output: ${singleLine(bounded.value)}${bounded.truncated ? " [truncated]" : ""}`)
    } else {
      console.log(`  Output: [${part.mimeType} omitted, ${part.byteLength} bytes]`)
    }
  }
  if (event.output.content.length === 0) console.log("  Output: [none]")
  if (event.output.details !== undefined) printValue("Details", event.output.details)
  if (event.output.truncated) console.log("  Output: [truncated]")
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "thinking.started":
      console.log("Thinking started.")
      return
    case "thinking.finished":
      console.log(`Thinking finished: ${singleLine(event.content)}`)
      return
    case "message.started":
      console.log("Message started.")
      return
    case "message.finished":
      console.log(`Message finished: ${singleLine(event.text)}`)
      return
    case "tool.started":
      console.log(`Tool started: ${event.toolName}`)
      printValue("Params", event.argsTruncated ? "[omitted]" : event.args)
      return
    case "tool.finished":
      console.log(`Tool finished: ${event.toolName}${event.isError ? " with an error" : ""}`)
      printOutput(event)
  }
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
    .command("create <name>")
    .description("Create a durable Pi agent")
    .option("--cwd <path>", "working directory", process.cwd())
    .addHelpText("after", "\nArguments after -- pass through to Pi.")
    .action(async (name: string, options: { cwd: string }) => {
      const agent = await withClient((client) => client.create({ name, cwd: options.cwd, piArgs }))
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
    .command("receive <name>")
    .description("Show live agent activity")
    .action(async (name: string) => {
      let interrupted = false
      await withClient(async (client) => {
        const onInterrupt = () => {
          interrupted = true
          void client.close()
        }
        process.once("SIGINT", onInterrupt)
        try {
          for await (const event of (await client.get(name)).receive()) printEvent(event)
        } finally {
          process.off("SIGINT", onInterrupt)
        }
      })
      if (interrupted) process.exitCode = 130
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
