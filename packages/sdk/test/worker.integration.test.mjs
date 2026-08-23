import assert from "node:assert/strict"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { connectPiFleet } from "../dist/index.js"
import { openRegistry } from "../dist/internal/registry.js"
import { requestSend, requestStatus } from "../dist/internal/worker-client.js"

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs")

async function terminateWorker(stateDir, id) {
  const registry = await openRegistry(stateDir)
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
  for (const [key, value] of Object.entries(options)) {
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
    const registry = await openRegistry(stateDir)
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

test("worker returns Pi acceptance and persists working then idle", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "prompt-event", PI_FLEET_FAKE_PI_SETTLE_AFTER_PROMPT_MS: "150" }, async ({ stateDir, record }) => {
    assert.ok(record)
    const accepted = await requestSend(record, "Investigate NATS", "steer")
    assert.equal(typeof accepted.acceptedAt, "number")

    await waitFor(async () => (await requestStatus(record)).state === "working", "Worker did not report working")
    const registry = await openRegistry(stateDir)
    try {
      assert.equal(registry.getById(record.id)?.state, "working")
    } finally {
      await registry.close()
    }

    await waitFor(async () => (await requestStatus(record)).state === "idle", "Worker did not return to idle")
    const finalRegistry = await openRegistry(stateDir)
    try {
      assert.equal(finalRegistry.getById(record.id)?.state, "idle")
    } finally {
      await finalRegistry.close()
    }
  })
})

test("worker rejects invalid messages and returns a Pi prompt rejection without retrying", { concurrency: false }, async () => {
  await withWorker({ PI_FLEET_FAKE_PI_MODE: "reject-prompt" }, async ({ record }) => {
    assert.ok(record)
    await assert.rejects(requestSend(record, "   ", "steer"), { message: "Message must not be empty" })
    await assert.rejects(requestSend(record, "Rejected work", "steer"), { message: "fake prompt rejected" })
    assert.equal((await requestStatus(record)).state, "idle")
  })
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
