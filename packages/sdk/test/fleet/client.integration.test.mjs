import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { connectPiFleet, AgentNameTakenError, AgentNotFoundError } from "../../dist/index.js"
import { openStore } from "../../dist/state/store.js"

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
