import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { connectPiFleet, AgentNameTakenError, AgentNotFoundError, AgentUnavailableError, InvalidCursorError } from "../../dist/index.js"
import { decodeEventCursor, encodeEventCursor, openStore } from "../../dist/state/store.js"

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
    process.kill(pid, "SIGKILL")
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        return
      }
    }
    throw new Error(`Worker ${pid} did not exit after SIGKILL`)
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

test("destroys an agent and invalidates old handles before name reuse", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await agent.send("create durable activity")
      const firstEvent = await agent.receive({ fromStart: true })[Symbol.asyncIterator]().next()
      assert.equal(firstEvent.done, false)
      const oldCursor = firstEvent.value.cursor
      await agent.destroy()
      assert.deepEqual(await client.list(), [])
      await assert.rejects(client.get("researcher"), AgentNotFoundError)
      await assert.rejects(agent.status(), AgentNotFoundError)
      await assert.rejects(agent.send("after destroy"), AgentNotFoundError)
      assert.throws(() => agent.receive(), AgentNotFoundError)
      await assert.rejects(agent.destroy(), AgentNotFoundError)

      const destroyedStore = await openStore(stateDir)
      try {
        assert.deepEqual(destroyedStore.readEvents(agent.id, 0, Number.MAX_SAFE_INTEGER, 10), [])
      } finally {
        await destroyedStore.close()
      }

      const replacement = await client.create({ name: "researcher", cwd: process.cwd() })
      assert.notEqual(replacement.id, agent.id)
      assert.deepEqual(await replacement.status(), { id: replacement.id, name: "researcher", state: "idle" })
      await assert.rejects(replacement.receive({ after: oldCursor })[Symbol.asyncIterator]().next(), InvalidCursorError)
      await terminateWorker(stateDir, replacement.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("delivers agent.destroyed then ends a public receive stream normally", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await agent.send("create replay activity")
      const iterator = agent.receive({ fromStart: true })[Symbol.asyncIterator]()
      assert.equal((await iterator.next()).done, false)
      const destroying = agent.destroy()
      const events = []
      while (true) {
        const result = await iterator.next()
        if (result.done) break
        events.push(result.value)
      }
      await destroying
      assert.equal(events.at(-1)?.type, "agent.destroyed")
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("recovers an unavailable worker before destroy", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await terminateWorker(stateDir, agent.id)
      await agent.destroy()
      assert.deepEqual(await client.list(), [])
    } finally {
      await client.close()
    }
  })
})

test("completes cleanup when the destroy worker exits after admission", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_IGNORE_SIGTERM = "1"
    const client = await connectPiFleet({ stateDir })
    let workerPid
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const before = await openStore(stateDir)
      try {
        workerPid = before.getById(agent.id)?.runtime?.workerPid
      } finally {
        await before.close()
      }
      assert.ok(workerPid)

      const destroying = agent.destroy()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const store = await openStore(stateDir)
        try {
          if (store.getById(agent.id)?.destroying) break
        } finally {
          await store.close()
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const marked = await openStore(stateDir)
      try {
        assert.ok(marked.getById(agent.id)?.destroying)
      } finally {
        await marked.close()
      }
      process.kill(workerPid, "SIGKILL")

      await destroying
      const after = await openStore(stateDir)
      try {
        assert.equal(after.getById(agent.id), undefined)
      } finally {
        await after.close()
      }
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_IGNORE_SIGTERM
      if (workerPid) {
        try { process.kill(workerPid, "SIGKILL") } catch {}
      }
      await client.close()
    }
  })
})

test("creates a durable agent that another SDK client can discover and query", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const creator = await connectPiFleet({ stateDir })
    const agent = await creator.create({ name: "researcher", cwd: process.cwd() })
    const createdStore = await openStore(stateDir)
    try {
      assert.equal(typeof createdStore.getById(agent.id)?.runtime?.claimId, "string")
      assert.equal(typeof createdStore.getById(agent.id)?.runtime?.claimedAt, "number")
    } finally {
      await createdStore.close()
    }
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

test("replaces an unavailable worker before status and send", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const store = await openStore(stateDir)
      const before = store.getById(agent.id)
      await store.close()
      assert.ok(before?.runtime?.workerPid)
      assert.ok(before?.runtime?.endpoint)
      await terminateWorker(stateDir, agent.id)

      assert.equal((await agent.status()).state, "idle")
      assert.equal(typeof (await agent.send("Continue after worker replacement")).acceptedAt, "number")

      const afterStore = await openStore(stateDir)
      try {
        const after = afterStore.getById(agent.id)
        assert.notEqual(after?.runtime?.generation, before.runtime.generation)
        assert.notEqual(after?.runtime?.workerPid, before.runtime.workerPid)
        assert.notEqual(after?.runtime?.endpoint, before.runtime.endpoint)
        assert.equal(after?.runtime?.state, "ready")
      } finally {
        await afterStore.close()
      }
    } finally {
      await client.close()
    }
  })
})

test("converges concurrent SDK recovery calls on one replacement worker", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const first = await connectPiFleet({ stateDir })
    const second = await connectPiFleet({ stateDir })
    try {
      const agent = await first.create({ name: "researcher", cwd: process.cwd() })
      await terminateWorker(stateDir, agent.id)
      const [firstStatus, secondStatus] = await Promise.all([
        (await first.get("researcher")).status(),
        (await second.get("researcher")).status(),
      ])
      assert.equal(firstStatus.state, "idle")
      assert.equal(secondStatus.state, "idle")
      const store = await openStore(stateDir)
      try {
        assert.equal(store.getById(agent.id)?.runtime?.state, "ready")
      } finally {
        await store.close()
      }
    } finally {
      await first.close()
      await second.close()
    }
  })
})

test("converges separate SDK processes on one replacement worker", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    const creator = await connectPiFleet({ stateDir })
    try {
      const agent = await creator.create({ name: "researcher", cwd: process.cwd() })
      await terminateWorker(stateDir, agent.id)
      const readyDir = join(stateDir, "recovery-ready")
      const goFile = join(stateDir, "recovery-go")
      const sdkUrl = new URL("../../dist/index.js", import.meta.url).href
      const script = `
        import { access, mkdir, writeFile } from "node:fs/promises";
        import { connectPiFleet } from ${JSON.stringify(sdkUrl)};
        const [stateDir, readyDir, goFile] = process.argv.slice(1);
        await mkdir(readyDir, { recursive: true });
        await writeFile(readyDir + "/" + process.pid, "ready");
        while (true) {
          try { await access(goFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
        const client = await connectPiFleet({ stateDir });
        try {
          const status = await (await client.get("researcher")).status();
          process.stdout.write(JSON.stringify(status));
        } finally {
          await client.close();
        }
      `
      const first = execFileAsync(process.execPath, ["--input-type=module", "--eval", script, stateDir, readyDir, goFile])
      const second = execFileAsync(process.execPath, ["--input-type=module", "--eval", script, stateDir, readyDir, goFile])
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await readdir(readyDir)).length === 2) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal((await readdir(readyDir)).length, 2)
      await writeFile(goFile, "go")
      const results = await Promise.all([first, second])
      for (const { stdout } of results) assert.equal(JSON.parse(stdout).state, "idle")
      assert.equal(Number(await readFile(incarnationFile, "utf8")), 2)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      await creator.close()
    }
  })
})

test("releases only its claim when replacement startup fails", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_FAIL_RECOVERY = "1"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await terminateWorker(stateDir, agent.id)
      await assert.rejects(agent.status(), AgentUnavailableError)
      const store = await openStore(stateDir)
      try {
        const record = store.getById(agent.id)
        assert.equal(record?.id, agent.id)
        assert.equal(record?.runtime?.state, "starting")
        assert.equal(record?.runtime?.claimId, undefined)
        assert.equal(record?.lastEventSeq, 0)
      } finally {
        await store.close()
      }
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_FAIL_RECOVERY
      await client.close()
    }
  })
})

test("fails recovery without signaling an old process group that stays alive", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_IGNORE_STDIN_END = "1"
    const client = await connectPiFleet({ stateDir })
    let piPid
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const store = await openStore(stateDir)
      const before = store.getById(agent.id)
      await store.close()
      assert.ok(before?.runtime?.workerPid)
      piPid = Number(await readFile(piPidFile, "utf8"))
      process.kill(before.runtime.workerPid, "SIGKILL")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          process.kill(before.runtime.workerPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      await assert.rejects(agent.status(), AgentUnavailableError)
      assert.doesNotThrow(() => process.kill(piPid, 0))
      const afterStore = await openStore(stateDir)
      try {
        const after = afterStore.getById(agent.id)
        assert.notEqual(after?.runtime?.generation, before.runtime.generation)
        assert.equal(after?.runtime?.claimId, undefined)
        assert.equal(after?.state, "idle")
        assert.equal(after?.lastEventSeq, 0)
      } finally {
        await afterStore.close()
      }
    } finally {
      if (piPid) {
        try { process.kill(piPid, "SIGKILL") } catch (error) { if (error?.code !== "ESRCH") throw error }
      }
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_IGNORE_STDIN_END
      await client.close()
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
        for await (const event of agent.receive({ fromStart: true })) {
          events.push(event)
          if (event.type === "message.finished" && event.text === "Handled: Public stream") sawExpectedMessage = true
          if (sawExpectedMessage) break
        }
      })()

      await agent.send("Warmup")
      await agent.send("Public stream")
      await receiving

      const currentEvents = events.slice(-6)
      assert.deepEqual(currentEvents.map(({ type }) => type), [
        "thinking.started",
        "thinking.finished",
        "tool.started",
        "tool.finished",
        "message.started",
        "message.finished",
      ])
      assert.deepEqual(currentEvents[2].args, { command: "pwd" })
      assert.equal(currentEvents[2].argsTruncated, false)
      assert.deepEqual(currentEvents[3].output, {
        content: [{ type: "text", text: "\u001b[31m/workspace\u001b[0m\nsecond line" }],
        details: { exitCode: 0 },
        detailsTruncated: false,
        truncated: false,
      })
      const journal = await openStore(stateDir)
      try {
        const record = journal.getById(agent.id)
        assert.ok(record)
        const persisted = journal.readEvents(agent.id, 0, record.lastEventSeq, record.lastEventSeq)
        assert.deepEqual(events, persisted.map((entry) => entry.event))
      } finally {
        await journal.close()
      }
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

      const mutableOptions = { fromStart: true }
      const snapshotted = agent.receive(mutableOptions)[Symbol.asyncIterator]()
      mutableOptions.fromStart = false
      assert.equal(decodeEventCursor((await snapshotted.next()).value.cursor).sequence, 1)
      await snapshotted.return()

      const replay = agent.receive({ fromStart: true })[Symbol.asyncIterator]()
      let cursor
      for (let index = 0; index < 6; index += 1) cursor = (await replay.next()).value.cursor
      await replay.return()

      await agent.send("After replay")
      const resumed = agent.receive({ after: cursor })[Symbol.asyncIterator]()
      const first = await resumed.next()
      assert.equal(first.value.type, "thinking.started")
      assert.notEqual(first.value.cursor, cursor)
      await resumed.return()
      assert.throws(() => agent.receive({ fromStart: false, after: cursor }), /cannot be combined/)
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

test("reconnects a public live stream after worker replacement", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "semantic-events"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const iterator = agent.receive()[Symbol.asyncIterator]()
      const firstEvent = iterator.next()
      await agent.send("Warmup")
      await agent.send("Before replacement")

      let sawExpectedMessage = false
      let current = await firstEvent
      while (!current.done) {
        if (current.value.type === "message.finished" && current.value.text === "Handled: Before replacement") sawExpectedMessage = true
        if (sawExpectedMessage) break
        current = await iterator.next()
      }
      const previousSequence = decodeEventCursor(current.value.cursor).sequence
      await terminateWorker(stateDir, agent.id)

      const nextEvent = iterator.next()
      await agent.send("After replacement")
      const resumed = await nextEvent
      assert.equal(resumed.value.type, "thinking.started")
      assert.equal(decodeEventCursor(resumed.value.cursor).sequence, previousSequence + 1)
      await iterator.return()
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      await client.close()
    }
  })
})

test("replays one interruption when a working worker is replaced", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    process.env.PI_FLEET_FAKE_PI_MODE = "prompt-event"
    process.env.PI_FLEET_FAKE_PI_SETTLE_FILE = join(stateDir, "release-work")
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const iterator = agent.receive({ fromStart: true })[Symbol.asyncIterator]()
      await agent.send("Start work before worker loss")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if ((await agent.status()).state === "working") break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal((await agent.status()).state, "working")
      await terminateWorker(stateDir, agent.id)

      const interrupted = await iterator.next()
      assert.equal(interrupted.value.type, "work.interrupted")
      assert.equal(decodeEventCursor(interrupted.value.cursor).sequence, 1)
      assert.equal((await agent.status()).state, "idle")
      await iterator.return()
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      delete process.env.PI_FLEET_FAKE_PI_SETTLE_FILE
      await client.close()
    }
  })
})

test("client close waits for an active worker recovery before closing the store", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const recoveryStartedFile = join(stateDir, "worker-recovery-started")
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE = recoveryStartedFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "500"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await terminateWorker(stateDir, agent.id)
      const status = agent.status()
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await readFile(recoveryStartedFile)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      await client.close()
      assert.equal((await status).state, "idle")
      const store = await openStore(stateDir)
      try {
        assert.equal(store.getById(agent.id)?.runtime?.state, "ready")
      } finally {
        await store.close()
      }
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
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
