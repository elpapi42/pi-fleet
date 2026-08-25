import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Dealer } from "zeromq"
import { connectPiFleet } from "../../dist/index.js"
import { decodeEventCursor, openStore } from "../../dist/state/store.js"
import { launchWorker, requestSend, requestStatus } from "../../dist/worker/control.js"
import { decode, encode } from "../../dist/worker/protocol.js"

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "../pi/fake-pi.mjs")

async function terminateWorker(stateDir, id) {
  const registry = await openStore(stateDir)
  try {
    const pid = registry.getById(id)?.runtime?.workerPid
    if (!pid) return
    try {
      process.kill(pid, "SIGTERM")
    } catch (error) {
      if (error?.code !== "ESRCH") throw error
      return
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

async function subscribe(record, options = {}) {
  const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
  socket.connect(record.runtime.endpoint)
  const request = {
    version: 1,
    requestId: randomUUID(),
    command: "subscribe",
    agentId: record.id,
    runtimeGeneration: record.runtime.generation,
    ...options,
  }
  await socket.send(encode(request))
  const response = decode((await socket.receive())[0])
  assert.equal(response.command, "subscribe")
  assert.equal(response.ok, true)
  assert.equal(response.agentId, record.id)
  assert.equal(response.runtimeGeneration, record.runtime.generation)
  assert.equal(typeof response.subscriptionId, "string")
  return { socket, subscriptionId: response.subscriptionId, afterSequence: response.afterSequence, resumeCursor: response.resumeCursor }
}

async function receiveEvent(subscription) {
  return decode((await subscription.socket.receive())[0])
}

function destroyRequest(record) {
  return {
    version: 1,
    requestId: randomUUID(),
    command: "destroy",
    agentId: record.id,
    runtimeGeneration: record.runtime.generation,
  }
}

function sendRequest(record, message, deadlineAt = Date.now() + 40_000) {
  return {
    version: 1,
    requestId: randomUUID(),
    command: "send",
    agentId: record.id,
    runtimeGeneration: record.runtime.generation,
    message,
    delivery: "steer",
    deadlineAt,
  }
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function withWorker(options, run) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-worker-"))
  const previous = new Map()
  const resolvedOptions = typeof options === "function" ? options(stateDir) : options
  for (const [key, value] of Object.entries(resolvedOptions)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.env.PI_FLEET_PI_COMMAND = fakePi
  let client
  let agent
  try {
    await chmod(fakePi, 0o755)
    client = await connectPiFleet({ stateDir })
    agent = await client.create({ name: "researcher", cwd: process.cwd() })
    const registry = await openStore(stateDir)
    try {
      await run({ stateDir, agent, record: registry.getById(agent.id) })
    } finally {
      await registry.close()
    }
  } finally {
    if (agent) await terminateWorker(stateDir, agent.id)
    await client?.close()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete process.env.PI_FLEET_PI_COMMAND
    await rm(stateDir, { recursive: true, force: true })
  }
}

test("destroys active work after publishing the final event and stream terminal", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_MODE: "prompt-event",
      PI_FLEET_FAKE_PI_SETTLE_FILE: join(stateDir, "settle"),
    }),
    async ({ stateDir, record }) => {
      assert.ok(record?.runtime?.endpoint)
      const subscription = await subscribe(record)
      const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
      socket.connect(record.runtime.endpoint)
      try {
        await requestSend(record, "active work", "steer")
        await waitFor(async () => (await requestStatus(record)).state === "working", "Worker did not become working")
        const request = destroyRequest(record)
        await socket.send(encode(request))
        const finalEvent = await receiveEvent(subscription)
        assert.equal(finalEvent.command, "event")
        assert.equal(finalEvent.event.type, "agent.destroyed")
        assert.equal(finalEvent.sequence, 1)
        const terminal = await receiveEvent(subscription)
        assert.equal(terminal.command, "stream.end")
        const response = decode((await socket.receive())[0])
        assert.equal(response.command, "destroy")
        assert.equal(response.ok, true)
        await waitFor(async () => {
          const store = await openStore(stateDir)
          try { return store.getById(record.id) === undefined } finally { await store.close() }
        }, "Destroy cleanup did not remove the old agent")
      } finally {
        socket.close()
        subscription.socket.close()
      }
    },
  )
})

test("does not deliver sends after destroy admission", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_PROMPT_DELAY_MS: "200",
      PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE: join(stateDir, "prompt-started"),
      PI_FLEET_FAKE_PI_COMMAND_LOG_FILE: join(stateDir, "commands.log"),
    }),
    async ({ stateDir, record }) => {
      assert.ok(record?.runtime?.endpoint)
      const first = requestSend(record, "before destroy", "steer")
      await waitFor(async () => {
        try { await access(join(stateDir, "prompt-started")); return true } catch { return false }
      }, "Fake Pi did not receive the first prompt")
      const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
      socket.connect(record.runtime.endpoint)
      try {
        const destroy = destroyRequest(record)
        await socket.send(encode(destroy))
        await waitFor(async () => {
          const store = await openStore(stateDir)
          try { return store.getByName(record.name) === undefined } finally { await store.close() }
        }, "Destroy admission did not remove the name")
        await assert.rejects(requestSend(record, "after destroy", "steer"))
        await first
        const response = decode((await socket.receive())[0])
        assert.equal(response.command, "destroy")
        assert.equal(response.ok, true)
        const prompts = (await readFile(join(stateDir, "commands.log"), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
          .map(({ request }) => request)
          .filter(({ type }) => type === "prompt")
        assert.deepEqual(prompts.map(({ message }) => message), ["before destroy"])
      } finally {
        socket.close()
      }
    },
  )
})

test("starts a replacement worker only for its matching runtime claim", { concurrency: false }, async () => {
  await withWorker({}, async ({ stateDir, agent, record }) => {
    assert.ok(record)
    await terminateWorker(stateDir, agent.id)
    const store = await openStore(stateDir)
    let replacement
    try {
      const claim = await store.claimRuntime(agent.id, record.runtime.generation, {
        generation: "replacement-generation",
        claimId: "replacement-claim",
        claimedAt: Date.now(),
        endpoint: `ipc://${join(stateDir, "ipc", "replacement.sock")}`,
        workerPid: record.runtime.workerPid,
      })
      assert.ok(claim)
      replacement = launchWorker(stateDir, agent.id, "replacement-generation", "replacement-claim")
      const replacementRecord = claim.record
      await waitFor(async () => {
        try {
          return (await requestStatus(replacementRecord)).runtimeGeneration === "replacement-generation"
        } catch {
          return false
        }
      }, "Replacement worker did not become ready")
      assert.equal(store.getById(agent.id)?.runtime?.claimId, "replacement-claim")
      assert.equal(store.getById(agent.id)?.runtime?.state, "ready")
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 0))
      replacement?.kill("SIGTERM")
    }
  })
})

test("persists the exact semantic events it publishes to independent subscribers", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "semantic-events" }, async ({ stateDir, agent, record }) => {
    assert.ok(record)
    const first = await subscribe(record)
    const second = await subscribe(record)
    try {
      await requestSend(record, "Inspect the project", "steer")
      assert.match((await requestStatus(record)).state, /^(working|idle)$/)
      const firstEvents = []
      const secondEvents = []
      for (let index = 0; index < 6; index += 1) firstEvents.push(await receiveEvent(first))
      for (let index = 0; index < 6; index += 1) secondEvents.push(await receiveEvent(second))
      const types = ["thinking.started", "thinking.finished", "tool.started", "tool.finished", "message.started", "message.finished"]
      assert.deepEqual(firstEvents.map((event) => event.event.type), types)
      assert.deepEqual(secondEvents.map((event) => event.event.type), types)
      assert.deepEqual(firstEvents.map((event) => event.event), secondEvents.map((event) => event.event))
      const journal = await openStore(stateDir)
      try {
        const current = journal.getById(agent.id)
        assert.ok(current)
        const persisted = journal.readEvents(agent.id, 0, current.lastEventSeq, current.lastEventSeq)
        assert.deepEqual(firstEvents.map((event) => event.event), persisted.map((entry) => entry.event))
      } finally {
        await journal.close()
      }
      assert.equal(firstEvents[0].event.activityId, firstEvents[1].event.activityId)
      assert.equal(firstEvents[2].event.activityId, firstEvents[3].event.activityId)
      assert.equal(firstEvents[4].event.activityId, firstEvents[5].event.activityId)
      assert.equal(firstEvents[1].event.content, "I will check.")
      assert.deepEqual(firstEvents[2].event.args, { command: "pwd" })
      assert.equal(firstEvents[2].event.argsTruncated, false)
      assert.equal(firstEvents[3].event.isError, false)
      assert.deepEqual(firstEvents[3].event.output, {
        content: [{ type: "text", text: "\u001b[31m/workspace\u001b[0m\nsecond line" }],
        details: { exitCode: 0 },
        detailsTruncated: false,
        truncated: false,
      })
      assert.equal(firstEvents[5].event.text, "Handled: Inspect the project")
    } finally {
      first.socket.close()
      second.socket.close()
    }
  })
})

test("replays durable activity from the start then continues at the live tail", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "semantic-events" }, async ({ stateDir, record }) => {
    assert.ok(record)
    await requestSend(record, "Before subscription", "steer")
    await waitFor(async () => {
      const store = await openStore(stateDir)
      try { return store.getById(record.id)?.lastEventSeq === 6 } finally { await store.close() }
    }, "Worker did not persist the first activity")

    const liveTail = await subscribe(record)
    assert.equal(liveTail.afterSequence, 6)
    assert.deepEqual(decodeEventCursor(liveTail.resumeCursor), { agentId: record.id, sequence: 6 })
    liveTail.socket.close()

    const replay = await subscribe(record, { fromStart: true })
    assert.equal(replay.afterSequence, 0)
    assert.equal(replay.resumeCursor, undefined)
    try {
      const replayed = []
      for (let index = 0; index < 6; index += 1) replayed.push(await receiveEvent(replay))
      assert.deepEqual(replayed.map((frame) => frame.sequence), [1, 2, 3, 4, 5, 6])
      assert.equal(replayed[5].event.cursor.startsWith("pf1."), true)
      await requestSend(record, "After subscription", "steer")
      assert.equal((await receiveEvent(replay)).sequence, 7)
    } finally {
      replay.socket.close()
    }
  })
})

test("worker returns Pi acceptance and persists working then idle", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({ PI_FLEET_FAKE_PI_MODE: "prompt-event", PI_FLEET_FAKE_PI_SETTLE_FILE: join(stateDir, "settle") }),
    async ({ stateDir, record }) => {
    assert.ok(record)
    const accepted = await requestSend(record, "Investigate NATS", "steer")
    assert.equal(typeof accepted.acceptedAt, "number")

    await waitFor(async () => (await requestStatus(record)).state === "working", "Worker did not report working")
    const registry = await openStore(stateDir)
    try {
      assert.equal(registry.getById(record.id)?.state, "working")
    } finally {
      await registry.close()
    }

    await writeFile(join(stateDir, "settle"), "settle")
    await waitFor(async () => (await requestStatus(record)).state === "idle", "Worker did not return to idle")
    const finalRegistry = await openStore(stateDir)
    try {
      assert.equal(finalRegistry.getById(record.id)?.state, "idle")
    } finally {
      await finalRegistry.close()
    }
    },
  )
})

test("worker rejects invalid messages and returns a Pi prompt rejection without retrying", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "reject-prompt" }, async ({ record }) => {
    assert.ok(record)
    await assert.rejects(requestSend(record, "   ", "steer"), { message: "Message must not be empty" })
    await assert.rejects(requestSend(record, "Rejected work", "steer"), { message: "fake prompt rejected" })
    assert.equal((await requestStatus(record)).state, "idle")
  })
})

test("waits for a pending send handler during worker shutdown", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_MODE: "ignore-prompt",
      PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE: join(stateDir, "prompt-started"),
    }),
    async ({ stateDir, record }) => {
      assert.ok(record)
      const send = requestSend(record, "Pending work", "steer", 1_000)
      await waitFor(async () => {
        try {
          await access(join(stateDir, "prompt-started"))
          return true
        } catch {
          return false
        }
      }, "Fake Pi did not receive the pending prompt")

      await terminateWorker(stateDir, record.id)
      await assert.rejects(send)
    },
  )
})

test("serializes concurrent sends and keeps status responsive", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_PROMPT_DELAY_MS: "200",
      PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE: join(stateDir, "prompt-started"),
      PI_FLEET_FAKE_PI_COMMAND_LOG_FILE: join(stateDir, "commands.log"),
    }),
    async ({ stateDir, record }) => {
      assert.ok(record)
      const firstSend = requestSend(record, "First", "steer")
      await waitFor(async () => {
        try { await access(join(stateDir, "prompt-started")); return true } catch { return false }
      }, "Fake Pi did not receive the first prompt")
      const secondSend = requestSend(record, "Second", "followUp")
      assert.equal((await requestStatus(record, 100)).state, "idle")
      const [first, second] = await Promise.all([firstSend, secondSend])
      assert.equal(typeof first.acceptedAt, "number")
      assert.equal(typeof second.acceptedAt, "number")
      const prompts = (await readFile(join(stateDir, "commands.log"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .map(({ request }) => request)
        .filter(({ type }) => type === "prompt")
      assert.deepEqual(prompts.map(({ message }) => message), ["First", "Second"])
      assert.deepEqual(prompts.map(({ streamingBehavior }) => streamingBehavior), ["steer", "followUp"])
    },
  )
})

test("rejects expired sends before they reach Pi", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({ PI_FLEET_FAKE_PI_COMMAND_LOG_FILE: join(stateDir, "commands.log") }),
    async ({ stateDir, record }) => {
      assert.ok(record?.runtime?.endpoint)
      const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
      socket.connect(record.runtime.endpoint)
      try {
        const request = sendRequest(record, "expired", Date.now() + 1_000)
        await socket.send(encode(request))
        const response = decode((await socket.receive())[0])
        assert.equal(response.requestId, request.requestId)
        assert.equal(response.errorCode, "send-expired")
        const commands = await readFile(join(stateDir, "commands.log"), "utf8")
        assert.equal(commands.split("\n").filter(Boolean).map(JSON.parse).some(({ request }) => request.type === "prompt"), false)
      } finally {
        socket.close()
      }
    },
  )
})

test("bounds the recovery queue by count", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_PID_FILE: join(stateDir, "pi.pid"),
      PI_FLEET_FAKE_PI_INCARNATION_FILE: join(stateDir, "incarnation"),
      PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE: join(stateDir, "recovery-started"),
      PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS: "5000",
    }),
    async ({ stateDir, record }) => {
      assert.ok(record?.runtime?.endpoint)
      process.kill(Number(await readFile(join(stateDir, "pi.pid"), "utf8")), "SIGTERM")
      await waitFor(async () => {
        try { await access(join(stateDir, "recovery-started")); return true } catch { return false }
      }, "Replacement Pi did not start")

      const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
      socket.connect(record.runtime.endpoint)
      try {
        const requests = Array.from({ length: 33 }, (_, index) => sendRequest(record, `queued-${index}`))
        for (const request of requests) await socket.send(encode(request))
        const response = decode((await socket.receive())[0])
        assert.equal(response.requestId, requests[32].requestId)
        assert.equal(response.errorCode, "recovery-queue-full")
      } finally {
        socket.close()
      }
    },
  )
})

test("bounds recovery queue message bytes", { concurrency: false }, async () => {
  await withWorker(
    (stateDir) => ({
      PI_FLEET_FAKE_PI_PID_FILE: join(stateDir, "pi.pid"),
      PI_FLEET_FAKE_PI_INCARNATION_FILE: join(stateDir, "incarnation"),
      PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE: join(stateDir, "recovery-started"),
      PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS: "5000",
    }),
    async ({ stateDir, record }) => {
      assert.ok(record?.runtime?.endpoint)
      process.kill(Number(await readFile(join(stateDir, "pi.pid"), "utf8")), "SIGTERM")
      await waitFor(async () => {
        try { await access(join(stateDir, "recovery-started")); return true } catch { return false }
      }, "Replacement Pi did not start")

      const socket = new Dealer({ routingId: randomUUID(), immediate: true, linger: 0 })
      socket.connect(record.runtime.endpoint)
      try {
        const first = sendRequest(record, "a".repeat(600 * 1024))
        const second = sendRequest(record, "b".repeat(600 * 1024))
        await socket.send(encode(first))
        await socket.send(encode(second))
        const response = decode((await socket.receive())[0])
        assert.equal(response.requestId, second.requestId)
        assert.equal(response.errorCode, "recovery-queue-full")
      } finally {
        socket.close()
      }
    },
  )
})
