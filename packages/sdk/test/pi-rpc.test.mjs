import assert from "node:assert/strict"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { PiStartupError, startPi } from "../dist/internal/pi-rpc.js"

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs")

const record = (overrides = {}) => ({
  id: "agent-1",
  name: "researcher",
  cwd: process.cwd(),
  instructions: "Use concise answers.",
  piArgs: ["--offline"],
  state: "starting",
  runtime: { generation: "runtime-1", state: "starting" },
  lastEventSeq: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await once(child, "exit")
}

async function withFakePi(environment, run) {
  const previous = new Map()
  await chmod(fakePi, 0o755)
  for (const [key, value] of Object.entries({ PI_FLEET_PI_COMMAND: fakePi, ...environment })) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("starts Pi in RPC mode with durable instructions and arguments", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-pi-rpc-"))
  const argsFile = join(root, "args.json")
  try {
    await withFakePi({ PI_FLEET_FAKE_PI_ARGS_FILE: argsFile }, async () => {
      const pi = await startPi(record())
      try {
        assert.deepEqual(pi.state, {
          sessionFile: "/tmp/fake-pi-session.jsonl",
          sessionId: "fake-session",
        })
        assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
          "--mode",
          "rpc",
          "--offline",
          "--append-system-prompt",
          "Use concise answers.",
        ])
      } finally {
        await stop(pi.process)
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("decodes a get_state response split across UTF-8 chunks", { concurrency: false }, async () => {
  await withFakePi({
    PI_FLEET_FAKE_PI_MODE: "split",
    PI_FLEET_FAKE_SESSION_ID: "session-☃",
  }, async () => {
    const pi = await startPi(record())
    try {
      assert.equal(pi.state.sessionId, "session-☃")
    } finally {
      await stop(pi.process)
    }
  })
})

test("reports Pi startup stderr and reaps the failed process", { concurrency: false }, async () => {
  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "exit" }, async () => {
    await assert.rejects(
      startPi(record(), 1_000),
      (error) => error instanceof PiStartupError && error.message.includes("fake Pi startup failed"),
    )
  })
})
