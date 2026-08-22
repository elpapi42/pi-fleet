#!/usr/bin/env node
import { createInterface } from "node:readline"
import { writeFile } from "node:fs/promises"

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

const sessionFile = process.env.PI_FLEET_FAKE_SESSION_FILE ?? "/tmp/fake-pi-session.jsonl"
const sessionId = process.env.PI_FLEET_FAKE_SESSION_ID ?? "fake-session"
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  const request = JSON.parse(line)
  if (request.type === "get_state") {
    const delay = Number(process.env.PI_FLEET_FAKE_PI_DELAY_MS ?? 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const response = Buffer.from(`${JSON.stringify({
      type: "response",
      id: request.id,
      success: true,
      data: { sessionFile, sessionId, isStreaming: false, isCompacting: false },
    })}\n`)
    if (process.env.PI_FLEET_FAKE_PI_MODE === "split") {
      for (const byte of response) {
        process.stdout.write(Buffer.from([byte]))
        await new Promise((resolve) => setImmediate(resolve))
      }
    } else {
      process.stdout.write(response)
    }
    const exitAfterReadyMs = Number(process.env.PI_FLEET_FAKE_PI_EXIT_AFTER_READY_MS ?? 0)
    if (exitAfterReadyMs > 0) setTimeout(() => process.exit(0), exitAfterReadyMs)
  }
}
