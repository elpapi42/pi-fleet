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
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function capturePiArgs(overrides) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-pi-args-"))
  const argsFile = join(root, "args.json")
  try {
    return await withFakePi({ PI_FLEET_FAKE_PI_ARGS_FILE: argsFile }, async () => {
      const pi = await startPi(record(overrides))
      try {
        return {
          args: JSON.parse(await readFile(argsFile, "utf8")),
          state: pi.state,
        }
      } finally {
        await stop(pi.process)
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("starts Pi in RPC mode with durable instructions and arguments", { concurrency: false }, async () => {
  const result = await capturePiArgs({})
  assert.deepEqual(result.state, {
    sessionFile: "/tmp/fake-pi-session.jsonl",
    sessionId: "fake-session",
  })
  assert.deepEqual(result.args, [
    "--mode",
    "rpc",
    "--offline",
    "--append-system-prompt",
    "Use concise answers.",
  ])
})

test("preserves a user-selected session path instead of appending the observed path", { concurrency: false }, async () => {
  const result = await capturePiArgs({
    instructions: undefined,
    piArgs: ["--session", "/sessions/user-selected.jsonl"],
    sessionPath: "/sessions/observed.jsonl",
  })
  assert.deepEqual(result.args, [
    "--mode",
    "rpc",
    "--session",
    "/sessions/user-selected.jsonl",
  ])
})

test("preserves a user-selected session ID instead of appending a session path", { concurrency: false }, async () => {
  const result = await capturePiArgs({
    instructions: undefined,
    piArgs: ["--session-id", "user-session"],
    sessionPath: "/sessions/observed.jsonl",
  })
  assert.deepEqual(result.args, [
    "--mode",
    "rpc",
    "--session-id",
    "user-session",
  ])
})

test("preserves other user session selectors", { concurrency: false }, async () => {
  for (const piArgs of [["--continue"], ["-c"], ["--resume"], ["-r"], ["--fork", "source-session"]]) {
    const result = await capturePiArgs({
      instructions: undefined,
      piArgs,
      sessionPath: "/sessions/observed.jsonl",
    })
    assert.deepEqual(result.args, ["--mode", "rpc", ...piArgs])
  }
})

test("appends the observed session path when the user supplied no selector", { concurrency: false }, async () => {
  const result = await capturePiArgs({
    instructions: undefined,
    piArgs: ["--offline"],
    sessionPath: "/sessions/observed.jsonl",
  })
  assert.deepEqual(result.args, [
    "--mode",
    "rpc",
    "--offline",
    "--session",
    "/sessions/observed.jsonl",
  ])
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
