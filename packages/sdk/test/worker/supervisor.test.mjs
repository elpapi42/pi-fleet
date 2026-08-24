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

test("rejects an admitted send when Pi recovery exhausts", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-supervisor-recovery-"))
  const previousCommand = process.env.PI_FLEET_PI_COMMAND
  const previousPidFile = process.env.PI_FLEET_FAKE_PI_PID_FILE
  const previousIncarnationFile = process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
  const previousFailRecovery = process.env.PI_FLEET_FAKE_PI_FAIL_RECOVERY
  const pidFile = join(root, "pi.pid")
  const incarnationFile = join(root, "incarnation")
  process.env.PI_FLEET_PI_COMMAND = fakePi
  process.env.PI_FLEET_FAKE_PI_PID_FILE = pidFile
  process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
  process.env.PI_FLEET_FAKE_PI_FAIL_RECOVERY = "1"
  await chmod(fakePi, 0o755)

  let recoveryStartedResolve
  const recoveryStarted = new Promise((resolve) => { recoveryStartedResolve = resolve })
  let continueRecoveryResolve
  const continueRecovery = new Promise((resolve) => { continueRecoveryResolve = resolve })
  let recoveryFailedResolve
  const recoveryFailed = new Promise((resolve) => { recoveryFailedResolve = resolve })
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
    beforeRecovery: async () => {
      recoveryStartedResolve()
      await continueRecovery
    },
    loadRecord: () => record,
    onRecovered: async () => true,
    onRecoveryFailed: async () => { recoveryFailedResolve() },
  })
  try {
    await supervisor.start()
    process.kill(Number(await readFile(pidFile, "utf8")), "SIGTERM")
    await withDeadline(recoveryStarted, 5_000, "Pi recovery did not start")
    const rejected = assert.rejects(
      supervisor.send("queued during failed recovery", "steer", Date.now() + 40_000),
      (error) => error instanceof SupervisorSendFailure && error.code === "unavailable",
    )
    continueRecoveryResolve()
    await rejected
    await withDeadline(recoveryFailed, 5_000, "Pi recovery did not report failure")
    assert.equal(Number(await readFile(incarnationFile, "utf8")), 4)
  } finally {
    await supervisor.stop()
    restoreEnv("PI_FLEET_PI_COMMAND", previousCommand)
    restoreEnv("PI_FLEET_FAKE_PI_PID_FILE", previousPidFile)
    restoreEnv("PI_FLEET_FAKE_PI_INCARNATION_FILE", previousIncarnationFile)
    restoreEnv("PI_FLEET_FAKE_PI_FAIL_RECOVERY", previousFailRecovery)
    await rm(root, { recursive: true, force: true })
  }
})

async function withDeadline(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
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
    supervisor.cancelDestroy()
    await supervisor.send("second", "steer", Date.now() + 20_000)
    const prompts = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .map(({ request }) => request)
      .filter(({ type }) => type === "prompt")
    assert.deepEqual(prompts.map(({ message }) => message), ["first", "second"])
  } finally {
    await supervisor.stop()
    restoreEnv("PI_FLEET_PI_COMMAND", previousCommand)
    restoreEnv("PI_FLEET_FAKE_PI_PROMPT_DELAY_MS", previousDelay)
    restoreEnv("PI_FLEET_FAKE_PI_PROMPT_STARTED_FILE", previousStarted)
    restoreEnv("PI_FLEET_FAKE_PI_COMMAND_LOG_FILE", previousLog)
    await rm(root, { recursive: true, force: true })
  }
})
