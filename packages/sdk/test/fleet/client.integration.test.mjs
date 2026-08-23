import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { connectPiFleet, AgentNameTakenError, AgentNotFoundError, AgentUnavailableError } from "../../dist/index.js"
import { encodeEventCursor, openStore } from "../../dist/state/store.js"

const execFileAsync = promisify(execFile)
const fakePi = join(dirname(fileURLToPath(import.meta.url)), "../pi/fake-pi.mjs")

async function terminateWorker(stateDir, id) {
  const registry = await openStore(stateDir)
  try {
    const pid = registry.getById(id)?.runtime?.workerPid
    assert.ok(pid, `Agent ${id} must have a ready worker PID`)
    try {
      process.kill(pid, "SIGTERM")
    } catch (error) {
      if (error?.code === "ESRCH") return
      throw error
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        return
      }
    }
    throw new Error(`Worker ${pid} did not exit`)
  } finally {
    await registry.close()
  }
}

async function terminateAllWorkers(stateDir) {
  const registry = await openStore(stateDir)
  let ids
  try {
    ids = registry.list().map(({ id }) => id)
  } finally {
    await registry.close()
  }
  for (const id of ids) await terminateWorker(stateDir, id)
}

async function waitForUnavailable(status) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await status()
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Worker continued serving status after Pi exited")
}

async function withState(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-client-"))
  const previous = process.env.PI_FLEET_PI_COMMAND
  process.env.PI_FLEET_PI_COMMAND = fakePi
  try {
    await chmod(fakePi, 0o755)
    await run(stateDir)
  } finally {
    process.env.PI_FLEET_PI_COMMAND = previous
    await terminateAllWorkers(stateDir)
    await rm(stateDir, { recursive: true, force: true })
  }
}

test("creates a durable agent that another SDK client can discover and query", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const creator = await connectPiFleet({ stateDir })
    const agent = await creator.create({ name: "researcher", cwd: process.cwd() })
    await assert.rejects(creator.create({ name: "researcher", cwd: process.cwd() }), AgentNameTakenError)
    assert.throws(() => { agent.id = "another-id" }, TypeError)
    await creator.close()

    const observer = await connectPiFleet({ stateDir })
    try {
      assert.equal((await observer.get("researcher")).id, agent.id)
      assert.deepEqual(await observer.list(), [{ id: agent.id, name: "researcher", cwd: process.cwd(), state: "idle" }])
      assert.deepEqual(await (await observer.get("researcher")).status(), { id: agent.id, name: "researcher", state: "idle" })
    } finally {
      await terminateWorker(stateDir, agent.id)
      await observer.close()
    }
  })
})

test("waits for delayed Pi readiness and reaps Pi when the worker stops", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    process.env.PI_FLEET_FAKE_PI_DELAY_MS = "600"
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      assert.equal((await agent.status()).state, "idle")
      const piPid = Number(await readFile(piPidFile, "utf8"))
      await terminateWorker(stateDir, agent.id)
      assert.throws(() => process.kill(piPid, 0), { code: "ESRCH" })
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_DELAY_MS
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      await client.close()
    }
  })
})

test("stops serving status after Pi exits", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      await waitForUnavailable(() => agent.status())
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      await client.close()
    }
  })
})

test("passes user session selection arguments to Pi", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const argsFile = join(stateDir, "fake-pi-args.json")
    process.env.PI_FLEET_FAKE_PI_ARGS_FILE = argsFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({
        name: "researcher",
        cwd: process.cwd(),
        piArgs: ["--session", "/sessions/user-selected.jsonl"],
      })
      assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
        "--mode",
        "rpc",
        "--session",
        "/sessions/user-selected.jsonl",
      ])
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_ARGS_FILE
      await client.close()
    }
  })
})

test("sends work through an immutable agent handle", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const commandsFile = join(stateDir, "fake-pi-commands.json")
    process.env.PI_FLEET_FAKE_PI_COMMANDS_FILE = commandsFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const accepted = await agent.send("Investigate NATS")
      assert.equal(typeof accepted.acceptedAt, "number")
      const commands = JSON.parse(await readFile(commandsFile, "utf8"))
      assert.deepEqual(commands.at(-1), {
        id: commands.at(-1).id,
        type: "prompt",
        message: "Investigate NATS",
        streamingBehavior: "steer",
      })
      await assert.rejects(agent.send("   "), /Message must not be empty/)
      await assert.rejects(agent.send("message", { delivery: "invalid" }), /Invalid delivery/)
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_COMMANDS_FILE
      await client.close()
    }
  })
})

test("receives live semantic activity through the public agent handle", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const events = []
      const receiving = (async () => {
        let sawExpectedMessage = false
        for await (const event of agent.receive()) {
          events.push(event)
          if (event.type === "message.finished" && event.text === "Handled: Public stream") sawExpectedMessage = true
          if (sawExpectedMessage && event.type === "tool.finished") break
        }
      })()

      await agent.send("Warmup")
      await agent.send("Public stream")
      await receiving

      const currentEvents = events.slice(-6)
      assert.deepEqual(currentEvents.map(({ type }) => type), [
        "message.started",
        "thinking.started",
        "thinking.finished",
        "message.finished",
        "tool.started",
        "tool.finished",
      ])
      assert.deepEqual(currentEvents[4].args, { command: "pwd" })
      assert.equal(currentEvents[4].argsTruncated, false)
      assert.deepEqual(currentEvents[5].output, {
        content: [{ type: "text", text: "\u001b[31m/workspace\u001b[0m\nsecond line" }],
        details: { exitCode: 0 },
        detailsTruncated: false,
        truncated: false,
      })
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("replays public activity after a delivered cursor", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await agent.send("Before replay")

      const replay = agent.receive({ fromStart: true })[Symbol.asyncIterator]()
      let cursor
      for (let index = 0; index < 6; index += 1) cursor = (await replay.next()).value.cursor
      await replay.return()

      await agent.send("After replay")
      const resumed = agent.receive({ after: cursor })[Symbol.asyncIterator]()
      const first = await resumed.next()
      assert.equal(first.value.type, "message.started")
      assert.notEqual(first.value.cursor, cursor)
      await resumed.return()
      for (const invalidCursor of [
        "not-a-cursor",
        encodeEventCursor("other-agent", 1),
        encodeEventCursor(agent.id, 10_000),
      ]) {
        await assert.rejects(
          async () => agent.receive({ after: invalidCursor })[Symbol.asyncIterator]().next(),
          { name: "InvalidCursorError" },
        )
      }
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("worker failure rejects a public live stream", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const iterator = agent.receive()[Symbol.asyncIterator]()
      const firstEvent = iterator.next()
      await agent.send("Warmup")
      await agent.send("Failure stream")

      let sawExpectedMessage = false
      let current = await firstEvent
      while (!current.done) {
        if (current.value.type === "message.finished" && current.value.text === "Handled: Failure stream") sawExpectedMessage = true
        if (sawExpectedMessage && current.value.type === "tool.finished") break
        current = await iterator.next()
      }
      await terminateWorker(stateDir, agent.id)
      await assert.rejects(iterator.next(), AgentUnavailableError)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("client close ends a pending live stream", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const client = await connectPiFleet({ stateDir })
    const agent = await client.create({ name: "researcher", cwd: process.cwd() })
    const pending = agent.receive()[Symbol.asyncIterator]().next()

    await client.close()
    assert.deepEqual(await pending, { done: true, value: undefined })
  })
})

test("client close releases a live stream paused after an event", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const iterator = agent.receive()[Symbol.asyncIterator]()
      const firstEvent = iterator.next()
      await agent.send("Warmup")
      await agent.send("Close stream")
      assert.equal((await firstEvent).done, false)

      await client.close()
      assert.deepEqual(await iterator.next(), { done: true, value: undefined })
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("rejects only Pi arguments required for fleet durability and RPC", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const client = await connectPiFleet({ stateDir })
    try {
      await assert.rejects(
        client.create({ name: "mode", cwd: process.cwd(), piArgs: ["--mode", "text"] }),
        /managed by pi-fleet/,
      )
      await assert.rejects(
        client.create({ name: "ephemeral", cwd: process.cwd(), piArgs: ["--no-session"] }),
        /managed by pi-fleet/,
      )
    } finally {
      await client.close()
    }
  })
})

test("removes an agent record when Pi cannot become ready", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "exit"
    const client = await connectPiFleet({ stateDir })
    try {
      await assert.rejects(client.create({ name: "researcher", cwd: process.cwd() }))
      await assert.rejects(client.get("researcher"), AgentNotFoundError)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("worker remains available after its creating process exits", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const sdk = new URL("../../dist/index.js", import.meta.url).href
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import { connectPiFleet } from ${JSON.stringify(sdk)};
      const client = await connectPiFleet({ stateDir: ${JSON.stringify(stateDir)} });
      await client.create({ name: "researcher", cwd: ${JSON.stringify(process.cwd())} });
      await client.close();
    `], { env: { ...process.env, PI_FLEET_PI_COMMAND: fakePi } })

    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.get("researcher")
      assert.equal((await agent.status()).state, "idle")
      await terminateWorker(stateDir, agent.id)
    } finally {
      await client.close()
    }
  })
})
