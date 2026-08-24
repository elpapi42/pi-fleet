import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { PiSupervisor, SupervisorSendFailure } from "../../dist/worker/supervisor.js"

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "../pi/fake-pi.mjs")

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function waitForFile(path, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await readFile(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(message)
}

test("drains admitted sends before closing destroy admission", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-supervisor-destroy-"))
  const previousCommand = process.env.PI_FLEET_PI_COMMAND
  const previousDelay = process.env.PI_FLEET_FAKE_PI_PROMPT_DELAY_MS
  const previousStarted = process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE
  const previousLog = process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE
  const started = join(root, "prompt-started")
  const log = join(root, "commands.log")
  process.env.PI_FLEET_PI_COMMAND = fakePi
  process.env.PI_FLEET_FAKE_PI_PROMPT_DELAY_MS = "200"
  process.env.PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE = started
  process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE = log
  await chmod(fakePi, 0o755)

  const record = {
    id: "agent-1",
    name: "researcher",
    cwd: process.cwd(),
    piArgs: [],
    state: "idle",
    runtime: { generation: "runtime-1", state: "ready", claimId: "claim-1" },
    lastEventSeq: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const supervisor = new PiSupervisor({
    initial: record,
    generation: "runtime-1",
    onPiEvent: () => {},
    beforeRecovery: async () => {},
    loadRecord: () => record,
    onRecovered: async () => true,
    onRecoveryFailed: async () => {},
  })
  try {
    await supervisor.start()
    const first = supervisor.send("first", "steer", Date.now() + 20_000)
    await waitForFile(started, "Fake Pi did not receive the first prompt")
    const destroy = supervisor.prepareDestroy()
    await assert.rejects(
      supervisor.send("second", "steer", Date.now() + 20_000),
      (error) => error instanceof SupervisorSendFailure && error.code === "unavailable",
    )
    await first
    await destroy
    const prompts = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .map(({ request }) => request)
      .filter(({ type }) => type === "prompt")
    assert.deepEqual(prompts.map(({ message }) => message), ["first"])
  } finally {
    await supervisor.stop()
    restoreEnv("PI_FLEET_PI_COMMAND", previousCommand)
    restoreEnv("PI_FLEET_FAKE_PI_PROMPT_DELAY_MS", previousDelay)
    restoreEnv("PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE", previousStarted)
    restoreEnv("PI_FLEET_FAKE_PI_COMMAND_LOG_FILE", previousLog)
    await rm(root, { recursive: true, force: true })
  }
})
