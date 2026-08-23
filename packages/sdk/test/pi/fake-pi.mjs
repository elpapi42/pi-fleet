#!/usr/bin/env node
import { createInterface } from "node:readline"
import { access, writeFile } from "node:fs/promises"

if (process.env.PI_FLEET_FAKE_PI_ARGS_FILE) {
  await writeFile(process.env.PI_FLEET_FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)))
}
if (process.env.PI_FLEET_FAKE_PI_PID_FILE) {
  await writeFile(process.env.PI_FLEET_FAKE_PI_PID_FILE, String(process.pid))
}
if (process.env.PI_FLEET_FAKE_PI_MODE === "exit") {
  process.stderr.write("fake Pi startup failed\n")
  process.exit(1)
}

const sessionFile = "/tmp/fake-pi-session.jsonl"
const sessionId = process.env.PI_FLEET_FAKE_SESSION_ID ?? "fake-session"
const mode = process.env.PI_FLEET_FAKE_PI_MODE
const commands = []
const reversePrompts = []

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respondToState(request) {
  const delay = Number(process.env.PI_FLEET_FAKE_PI_DELAY_MS ?? 0)
  const response = Buffer.from(`${JSON.stringify({
    type: "response",
    id: request.id,
    success: true,
    data: { sessionFile, sessionId, isStreaming: false, isCompacting: false },
  })}\n`)
  const send = async () => {
    if (mode === "split") {
      for (const byte of response) {
        process.stdout.write(Buffer.from([byte]))
        await new Promise((resolve) => setImmediate(resolve))
      }
    } else {
      process.stdout.write(response)
    }
  }
  if (delay > 0) setTimeout(() => void send(), delay)
  else void send()
}

async function handlePrompt(request) {
  if (process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE) {
    await writeFile(process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE, "started")
  }
  if (mode === "exit-on-prompt") process.exit(0)
  if (mode === "ignore-prompt") return
  if (mode === "reject-prompt") {
    write({ type: "response", id: request.id, success: false, error: "fake prompt rejected" })
    return
  }
  const promptDelay = Number(process.env.PI_FLEET_FAKE_PI_PROMPT_DELAY_MS ?? 0)
  if (promptDelay > 0) await new Promise((resolve) => setTimeout(resolve, promptDelay))
  if (mode === "reverse-prompts") {
    reversePrompts.push(request)
    if (reversePrompts.length === 2) {
      for (const pending of [...reversePrompts].reverse()) {
        write({ type: "response", id: pending.id, success: true, command: "prompt" })
      }
    }
    return
  }
  if (mode === "prompt-event") write({ type: "agent_start" })
  write({ type: "response", id: request.id, success: true, command: "prompt" })
  const settleGate = process.env.PI_FLEET_FAKE_PI_SETTLE_FILE
  if (settleGate) {
    await waitForFile(settleGate)
    write({ type: "agent_settled" })
    return
  }
}

async function waitForFile(path) {
  while (true) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  void (async () => {
    const request = JSON.parse(line)
    commands.push(request)
    if (process.env.PI_FLEET_FAKE_PI_COMMANDS_FILE) {
      await writeFile(process.env.PI_FLEET_FAKE_PI_COMMANDS_FILE, JSON.stringify(commands))
    }
    if (request.type === "get_state") respondToState(request)
    if (request.type === "prompt") await handlePrompt(request)
  })()
})
