import assert from "node:assert/strict"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { PiRequestError, PiRequestUncertainError, PiStartupError, startPi } from "../../dist/pi/runtime.js"

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs")

const record = (overrides = {}) => ({
  id: "agent-1",
  name: "researcher",
  cwd: process.cwd(),
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

test("starts Pi in RPC mode with caller arguments", { concurrency: false }, async () => {
  const result = await capturePiArgs({})
  assert.deepEqual(result.state, {
    sessionFile: "/tmp/fake-pi-session.jsonl",
    sessionId: "fake-session",
  })
  assert.deepEqual(result.args, [
    "--mode",
    "rpc",
    "--offline",
  ])
})

test("preserves a user-selected session path instead of appending the observed path", { concurrency: false }, async () => {
  const result = await capturePiArgs({
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
      piArgs,
      sessionPath: "/sessions/observed.jsonl",
    })
    assert.deepEqual(result.args, ["--mode", "rpc", ...piArgs])
  }
})

test("appends the observed session path when the user supplied no selector", { concurrency: false }, async () => {
  const result = await capturePiArgs({
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

test("cancels Pi startup and reaps the process", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-pi-cancel-"))
  const pidFile = join(root, "pi.pid")
  try {
    await withFakePi({ PI_FLEET_FAKE_PI_DELAY_MS: "5000", PI_FLEET_FAKE_PI_PID_FILE: pidFile }, async () => {
      const controller = new AbortController()
      const starting = startPi(record(), 10_000, undefined, controller.signal)
      let pid
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          pid = Number(await readFile(pidFile, "utf8"))
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      assert.ok(pid)
      controller.abort()
      await assert.rejects(starting, PiStartupError)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("sends a prompt after readiness and receives interleaved Pi events", { concurrency: false }, async () => {
  const events = []
  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "prompt-event" }, async () => {
    const pi = await startPi(record(), 1_000, (event) => events.push(event))
    try {
      await pi.send("Analyze the repository", "steer")
      assert.deepEqual(events, [{ type: "agent_start" }])
    } finally {
      await stop(pi.process)
    }
  })
})

test("uses prompt streamingBehavior for follow-up delivery", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-pi-send-"))
  const commandsFile = join(root, "commands.json")
  try {
    await withFakePi({ PI_FLEET_FAKE_PI_COMMANDS_FILE: commandsFile }, async () => {
      const pi = await startPi(record())
      try {
        await pi.send("Continue after the current work", "followUp")
      } finally {
        await stop(pi.process)
      }
    })
    const commands = JSON.parse(await readFile(commandsFile, "utf8"))
    assert.equal(commands.length, 2)
    assert.match(commands[1].id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(commands[1], {
      id: commands[1].id,
      type: "prompt",
      message: "Continue after the current work",
      streamingBehavior: "followUp",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("correlates concurrent prompt responses by Pi request ID", { concurrency: false }, async () => {
  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "reverse-prompts" }, async () => {
    const pi = await startPi(record())
    try {
      await Promise.all([
        pi.send("First request", "steer"),
        pi.send("Second request", "followUp"),
      ])
    } finally {
      await stop(pi.process)
    }
  })
})

test("reports Pi prompt rejection messages", { concurrency: false }, async () => {
  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "reject-prompt" }, async () => {
    const pi = await startPi(record())
    try {
      await assert.rejects(
        pi.send("Rejected prompt", "steer"),
        (error) => error instanceof PiRequestError && error.message === "fake prompt rejected",
      )
    } finally {
      await stop(pi.process)
    }
  })
})

test("times out and rejects pending prompts when Pi exits", { concurrency: false }, async () => {
  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "exit-on-prompt" }, async () => {
    const pi = await startPi(record())
    try {
      await assert.rejects(pi.send("Exit before acknowledgment", "steer", 1_000), PiRequestUncertainError)
    } finally {
      await stop(pi.process)
    }
  })

  await withFakePi({ PI_FLEET_FAKE_PI_MODE: "ignore-prompt" }, async () => {
    const pi = await startPi(record())
    try {
      await assert.rejects(pi.send("Timeout", "steer", 20), PiRequestUncertainError)
    } finally {
      await stop(pi.process)
    }
  })
})
