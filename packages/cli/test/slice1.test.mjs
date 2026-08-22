import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
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
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const argsFile = join(root, "fake-pi-args.json")
  let createdId
  try {
    await chmod(fakePi, 0o755)
    const env = {
      HOME: home,
      PI_FLEET_PI_COMMAND: fakePi,
      PI_FLEET_FAKE_PI_ARGS_FILE: argsFile,
    }
    const created = await run(
      ["create", "researcher", "Use concise answers.", "--cwd", process.cwd(), "--", "--session-id", "existing"],
      env,
    )
    createdId = created.stdout.match(/^ID: (.+)$/m)?.[1]
    assert.match(created.stdout, /^Created agent researcher$/m)
    assert.ok(createdId)
    assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
      "--mode",
      "rpc",
      "--session-id",
      "existing",
      "--append-system-prompt",
      "Use concise answers.",
    ])

    const listed = await run(["list"], env)
    const status = await run(["status", "researcher"], env)
    assert.match(listed.stdout, /^NAME\s+STATE\s+ID$/m)
    assert.match(listed.stdout, new RegExp(`^researcher\\s+idle\\s+${createdId}$`, "m"))
    assert.match(status.stdout, new RegExp(`^ID: ${createdId}$`, "m"))
    assert.match(status.stdout, /^Name: researcher$/m)
    assert.match(status.stdout, /^State: idle$/m)
  } finally {
    if (createdId) await terminateWorker(stateDir, createdId)
    await rm(root, { recursive: true, force: true })
  }
})

test("lists agents in sorted fixed-width columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-list-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const env = { HOME: home }
  const registry = await openRegistry(stateDir)
  try {
    const now = Date.now()
    for (const [id, name, state] of [
      ["agent-researcher", "researcher", "starting"],
      ["agent-coder", "coder", "idle"],
      ["agent-helper", "helper", "working"],
    ]) {
      await registry.create({
        id,
        name,
        cwd: process.cwd(),
        piArgs: [],
        state,
        lastEventSeq: 0,
        createdAt: now,
        updatedAt: now,
      })
    }

    const listed = await run(["list"], env)
    assert.equal(listed.stdout, [
      "NAME        STATE     ID",
      "coder       idle      agent-coder",
      "helper      working   agent-helper",
      "researcher  starting  agent-researcher",
      "",
    ].join("\n"))
  } finally {
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("uses Commander help and errors", async () => {
  const help = await run(["create", "--help"], {})
  assert.match(help.stdout, /Usage: pif create \[options\] <name> \[instructions\]/)
  assert.match(help.stdout, /--cwd <path>/)
  assert.match(help.stdout, /Arguments after -- pass through to Pi/)

  await assert.rejects(
    run(["status", "researcher", "extra"], {}),
    (error) => {
      assert.match(error.stderr, /error: too many arguments for 'status'/)
      assert.doesNotMatch(error.stderr, /\{"error":/)
      return true
    },
  )

  await assert.rejects(
    run(["list", "--", "--session", "user-session"], {}),
    (error) => {
      assert.match(error.stderr, /^Arguments after -- are supported only by pif create$/m)
      assert.match(error.stderr, /Usage: pif \[options\] \[command\]/)
      return true
    },
  )
})
