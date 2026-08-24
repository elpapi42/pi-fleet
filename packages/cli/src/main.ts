#!/usr/bin/env node
import { stripVTControlCharacters } from "node:util"
import { Command, Option } from "commander"
import { connectPiFleet, type AgentEvent } from "@elpapi42/pi-fleet-sdk"

const version = "0.12.0"

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

function safeText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
}

function singleLine(text: string): string {
  return safeText(text).replace(/\s+/g, " ").trim()
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

function formatValue(value: unknown): string {
  let text: string
  if (typeof value === "string") text = singleLine(value)
  else {
    try {
      text = singleLine(JSON.stringify(value) ?? "[unavailable]")
    } catch {
      text = "[unavailable]"
    }
  }
  const bounded = truncateUtf8(text)
  return `${bounded.value}${bounded.truncated ? " [truncated]" : ""}`
}

function printIndented(text: string): void {
  for (const line of safeText(text).split("\n")) console.log(`  ${line}`)
}

function textContent(event: Extract<AgentEvent, { type: "tool.finished" }>): string {
  return event.output.content
    .filter((part): part is Extract<(typeof event.output.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

class ActivityRenderer {
  readonly #verbose: boolean
  #hasOutput = false
  #openThinkingActivityId: string | undefined

  constructor(verbose: boolean) {
    this.#verbose = verbose
  }

  print(event: AgentEvent): void {
    switch (event.type) {
      case "thinking.started":
        this.block("Thinking...")
        this.#openThinkingActivityId = event.activityId
        return
      case "thinking.finished":
        if (this.#openThinkingActivityId === event.activityId) {
          printIndented(event.content || "[no content]")
          this.#openThinkingActivityId = undefined
        } else {
          this.block("Thinking")
          printIndented(event.content || "[no content]")
        }
        return
      case "message.started":
        return
      case "message.finished":
        this.block("Assistant")
        printIndented(event.text)
        return
      case "tool.started":
        this.block(`Tool: ${singleLine(event.toolName)}`)
        this.printParameters(event.args, event.argsTruncated)
        return
      case "tool.finished":
        this.block(`${event.isError ? "Tool failed" : "Tool complete"}: ${singleLine(event.toolName)}`)
        this.printToolOutput(event, event.isError || this.#verbose)
        return
      case "work.interrupted":
        this.block("Warning: Work interrupted")
        console.log("  The active work may be incomplete.")
    }
  }

  private block(title: string): void {
    if (this.#hasOutput) console.log()
    this.#hasOutput = true
    this.#openThinkingActivityId = undefined
    console.log(title)
  }

  private printParameters(args: unknown, truncated: boolean): void {
    if (truncated) {
      console.log("  args: [omitted]")
      return
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
      for (const [key, value] of Object.entries(args)) console.log(`  ${singleLine(key)}: ${formatValue(value)}`)
      return
    }
    console.log(`  args: ${formatValue(args)}`)
  }

  private printToolOutput(event: Extract<AgentEvent, { type: "tool.finished" }>, full: boolean): void {
    const text = textContent(event)
    const hasText = event.output.content.some((part) => part.type === "text")
    if (hasText) this.printText(text, full ? 8 * 1024 : 2 * 1024, full ? undefined : 8)
    for (const part of event.output.content) {
      if (part.type === "image") console.log(`  Output: [${singleLine(part.mimeType)} omitted, ${part.byteLength} bytes]`)
    }
    if (!hasText && event.output.content.length === 0) console.log("  Output: [none]")
    if (full && event.output.details !== undefined) console.log(`  Details: ${formatValue(event.output.details)}`)
    else if (full && event.output.detailsTruncated) console.log("  Details: [omitted]")
    if (event.output.truncated) console.log("  Note: output was truncated or omitted.")
  }

  private printText(text: string, maxBytes: number, maxLines: number | undefined): void {
    const bounded = truncateUtf8(safeText(text), maxBytes)
    const allLines = bounded.value.split("\n")
    const lines = maxLines === undefined ? allLines : allLines.slice(0, maxLines)
    if (lines.length === 1 && !bounded.truncated && lines.length === allLines.length) {
      console.log(`  Output: ${lines[0]}`)
      return
    }
    console.log("  Output:")
    for (const line of lines) console.log(`    ${line}`)
    if (allLines.length > lines.length) console.log(`  [${allLines.length - lines.length} more lines omitted]`)
    if (bounded.truncated) console.log("  [output truncated]")
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
    .description("Show durable agent activity")
    .addOption(new Option("--from-start", "replay activity from the first event").conflicts("after"))
    .option("--after <cursor>", "replay activity after a cursor")
    .option("--verbose", "show full bounded tool output and details")
    .action(async (name: string, options: { fromStart?: boolean; after?: string; verbose?: boolean }) => {
      let interrupted = false
      const renderer = new ActivityRenderer(options.verbose ?? false)
      await withClient(async (client) => {
        const onInterrupt = () => {
          interrupted = true
          void client.close()
        }
        process.once("SIGINT", onInterrupt)
        try {
          const receiveOptions = options.fromStart ? { fromStart: true } : options.after ? { after: options.after } : undefined
          for await (const event of (await client.get(name)).receive(receiveOptions)) renderer.print(event)
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
