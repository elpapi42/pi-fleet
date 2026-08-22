import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { openRegistry } from "../../sdk/dist/internal/registry.js"

const execFileAsync = promisify(execFile)
const pif = resolve("dist/main.js")
const fakePi = resolve("../sdk/test/fake-pi.mjs")

async function run(args, env) {
  return execFileAsync(process.execPath, [pif, ...args], { env: { ...process.env, ...env } })
}

async function terminateWorker(stateDir, id) {
  const registry = await openRegistry(stateDir)
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

test("creates, lists, and checks a durable agent through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-"))
  const stateHome = join(root, "state")
  const stateDir = join(stateHome, "pi-fleet")
  let created
  try {
    await chmod(fakePi, 0o755)
    const env = { XDG_STATE_HOME: stateHome, PI_FLEET_PI_COMMAND: fakePi }
    created = JSON.parse((await run(["create", "researcher", "--cwd", process.cwd()], env)).stdout)
    const listed = (await run(["list"], env)).stdout.trim().split("\n").map(JSON.parse)
    const status = JSON.parse((await run(["status", "researcher"], env)).stdout)
    assert.equal(created.name, "researcher")
    assert.equal(listed[0].id, created.id)
    assert.deepEqual(status, { id: created.id, name: "researcher", state: "idle" })
  } finally {
    if (created) await terminateWorker(stateDir, created.id)
    await rm(root, { recursive: true, force: true })
  }
})

test("writes command errors as compact JSONL", async () => {
  await assert.rejects(
    run(["status", "researcher", "extra"], {}),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), { error: "Usage: pif status NAME" })
      return true
    },
  )
})
