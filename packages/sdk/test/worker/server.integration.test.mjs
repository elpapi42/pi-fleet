import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Dealer } from "zeromq"
import { connectPiFleet } from "../../dist/index.js"
import { decodeEventCursor, openStore } from "../../dist/state/store.js"
import { requestSend, requestStatus } from "../../dist/worker/control.js"
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

test("publishes the same ordered semantic events to independent subscribers", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "semantic-events" }, async ({ record }) => {
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
      const types = ["message.started", "thinking.started", "thinking.finished", "message.finished", "tool.started", "tool.finished"]
      assert.deepEqual(firstEvents.map((event) => event.event.type), types)
      assert.deepEqual(secondEvents.map((event) => event.event.type), types)
      assert.deepEqual(firstEvents.map((event) => event.event), secondEvents.map((event) => event.event))
      assert.equal(firstEvents[0].event.activityId, firstEvents[3].event.activityId)
      assert.equal(firstEvents[1].event.activityId, firstEvents[2].event.activityId)
      assert.equal(firstEvents[2].event.content, "I will check.")
      assert.equal(firstEvents[3].event.text, "Handled: Inspect the project")
      assert.deepEqual(firstEvents[4].event.args, { command: "pwd" })
      assert.equal(firstEvents[4].event.argsTruncated, false)
      assert.equal(firstEvents[5].event.isError, false)
      assert.deepEqual(firstEvents[5].event.output, {
        content: [{ type: "text", text: "\u001b[31m/workspace\u001b[0m\nsecond line" }],
        details: { exitCode: 0 },
        detailsTruncated: false,
        truncated: false,
      })
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

test("worker correlates concurrent sends and keeps status responsive", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "reverse-prompts" }, async ({ record }) => {
    assert.ok(record)
    const [first, second] = await Promise.all([
      requestSend(record, "First", "steer"),
      requestSend(record, "Second", "followUp"),
    ])
    assert.equal(typeof first.acceptedAt, "number")
    assert.equal(typeof second.acceptedAt, "number")
    assert.equal((await requestStatus(record)).state, "idle")
  })

  await withWorker({ PI_FLEET_FAKE_PI_PROMPT_DELAY_MS: "200" }, async ({ record }) => {
    assert.ok(record)
    const send = requestSend(record, "Slow prompt", "steer")
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal((await requestStatus(record, 100)).state, "idle")
    await send
  })
})
