#!/usr/bin/env node
import { createInterface } from "node:readline"
import { access, appendFile, readFile, writeFile } from "node:fs/promises"

let incarnation = 1
if (process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE) {
  try {
    incarnation = Number(await readFile(process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE, "utf8")) + 1
  } catch {}
  await writeFile(process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE, String(incarnation))
}

if (process.env.PI_FLEET_FAKE_PI_ARGS_FILE) {
  await writeFile(process.env.PI_FLEET_FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)))
}
if (process.env.PI_FLEET_FAKE_PI_AGENT_DIR_FILE) {
  await writeFile(process.env.PI_FLEET_FAKE_PI_AGENT_DIR_FILE, JSON.stringify(process.env.PI_CODING_AGENT_DIR ?? null))
}
if (process.env.PI_FLEET_FAKE_PI_AGENT_DIR_LOG_FILE) {
  await appendFile(process.env.PI_FLEET_FAKE_PI_AGENT_DIR_LOG_FILE, `${JSON.stringify(process.env.PI_CODING_AGENT_DIR ?? null)}\n`)
}
if (process.env.PI_FLEET_FAKE_PI_PID_FILE) {
  await writeFile(process.env.PI_FLEET_FAKE_PI_PID_FILE, String(process.pid))
}
if (process.env.PI_FLEET_FAKE_PI_MODE === "exit" || incarnation > 1 && process.env.PI_FLEET_FAKE_PI_FAIL_RECOVERY === "1") {
  const delay = incarnation > 1 ? Number(process.env.PI_FLEET_FAKE_PI_RECOVERY_FAIL_DELAY_MS ?? 0) : 0
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  process.stderr.write("fake Pi startup failed\n")
  process.exit(1)
}

const sessionFile = process.env.PI_FLEET_FAKE_PI_SESSION_FILE ?? "/tmp/fake-pi-session.jsonl"
const sessionId = incarnation > 1
  ? process.env.PI_FLEET_FAKE_PI_RECOVERY_SESSION_ID ?? process.env.PI_FLEET_FAKE_SESSION_ID ?? "fake-session"
  : process.env.PI_FLEET_FAKE_SESSION_ID ?? "fake-session"
const mode = incarnation > 1 && process.env.PI_FLEET_FAKE_PI_RECOVERY_MODE
  ? process.env.PI_FLEET_FAKE_PI_RECOVERY_MODE
  : process.env.PI_FLEET_FAKE_PI_MODE
if (process.env.PI_FLEET_FAKE_PI_IGNORE_STDIN_END === "1") setInterval(() => {}, 1_000)
if (process.env.PI_FLEET_FAKE_PI_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {})
const commands = []
const reversePrompts = []

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function respondToState(request) {
  if (incarnation > 1 && process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE) {
    await writeFile(process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE, "started")
  }
  const delay = Number(incarnation > 1 ? process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS ?? process.env.PI_FLEET_FAKE_PI_DELAY_MS ?? 0 : process.env.PI_FLEET_FAKE_PI_DELAY_MS ?? 0)
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
    if (process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE) {
      await writeFile(process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE, String(incarnation))
    }
  }
  if (delay > 0) setTimeout(() => void send(), delay)
  else void send()
}

async function handlePrompt(request) {
  if (process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE) {
    await writeFile(process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE, "started")
  }
  const exitThisPrompt = !process.env.PI_FLEET_FAKE_PI_EXIT_ON_PROMPT_INCARNATION || Number(process.env.PI_FLEET_FAKE_PI_EXIT_ON_PROMPT_INCARNATION) === incarnation
  if (mode === "start-then-exit-on-prompt" && exitThisPrompt) {
    write({ type: "agent_start" })
    process.exit(0)
  }
  if (mode === "exit-on-prompt" && exitThisPrompt) process.exit(0)
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
  if (mode === "semantic-events" || mode === "semantic-error" || mode === "semantic-bounded-error" || mode === "semantic-preview" || mode === "semantic-preview-bytes") {
    write({ type: "agent_start" })
    write({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "ignored" }] } })
    write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ignored" } })
    write({ type: "tool_execution_start", toolCallId: 42, toolName: "invalid", args: {} })
    write({ type: "unsupported_event" })
    write({ type: "message_start", message: { role: "assistant", content: [] } })
    const responseText = `Handled: ${request.message}`
    write({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } })
    write({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "I will check." } })
    write({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "I will check." }, { type: "toolCall", id: "tool-1" }] } })
    write({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: mode === "semantic-bounded-error" ? "\u001b[31mbash\runsafe\u001b[0m" : "bash",
      args: mode === "semantic-bounded-error" ? { command: "x".repeat(16 * 1024 + 1) } : { command: "pwd" },
    })
    write({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: mode === "semantic-bounded-error" ? "\u001b[31mbash\runsafe\u001b[0m" : "bash",
      result: mode === "semantic-bounded-error"
        ? {
            content: [
              { type: "text", text: "command failed\rnext line" },
              { type: "image", mimeType: "\u001b[31mimage/png\runsafe\u001b[0m", data: "aGVsbG8=" },
            ],
            details: { stderr: "x".repeat(16 * 1024 + 1) },
          }
        : mode === "semantic-error"
          ? { content: [{ type: "text", text: "command failed" }], details: { exitCode: 1 } }
          : mode === "semantic-preview"
            ? { content: [{ type: "text", text: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") }], details: { exitCode: 0 } }
            : mode === "semantic-preview-bytes"
              ? { content: [{ type: "text", text: "x".repeat(2 * 1024 + 1) }], details: { exitCode: 0 } }
              : { content: [{ type: "text", text: "\u001b[31m/workspace\u001b[0m\nsecond line" }], details: { exitCode: 0 } },
      isError: mode === "semantic-error" || mode === "semantic-bounded-error",
    })
    write({ type: "message_start", message: { role: "assistant", content: [] } })
    write({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: responseText } })
    write({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: responseText } })
    write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: responseText }] } })
    write({ type: "agent_settled" })
  }
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
    if (process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE) {
      await appendFile(process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE, `${JSON.stringify({ incarnation, request })}\n`)
    }
    if (request.type === "get_state") await respondToState(request)
    if (request.type === "prompt") await handlePrompt(request)
  })()
})
