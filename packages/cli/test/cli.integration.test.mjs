import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { openStore } from "../../sdk/dist/state/store.js"

const execFileAsync = promisify(execFile)
const testDir = dirname(fileURLToPath(import.meta.url))
const pif = resolve(testDir, "../dist/main.js")
const fakePi = resolve(testDir, "../../sdk/test/pi/fake-pi.mjs")

async function run(args, env) {
  return execFileAsync(process.execPath, [pif, ...args], { env: { ...process.env, ...env } })
}

async function waitForText(child, getText, expected, timeoutMs = 5_000) {
  if (getText().includes(expected)) return
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdout.off("data", onData)
      reject(new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${JSON.stringify(getText())}`))
    }, timeoutMs)
    const onData = () => {
      if (!getText().includes(expected)) return
      clearTimeout(timeout)
      child.stdout.off("data", onData)
      resolve()
    }
    child.stdout.on("data", onData)
  })
}

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

test("creates, lists, and checks a durable agent through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const argsFile = join(root, "fake-pi-args.json")
  const commandsFile = join(root, "fake-pi-commands.json")
  let createdId
  try {
    await chmod(fakePi, 0o755)
    const env = {
      HOME: home,
      PI_FLEET_PI_COMMAND: fakePi,
      PI_FLEET_FAKE_PI_ARGS_FILE: argsFile,
      PI_FLEET_FAKE_PI_COMMANDS_FILE: commandsFile,
    }
    const created = await run(
      ["create", "researcher", "--cwd", process.cwd(), "--", "--session-id", "existing"],
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
    ])

    const sent = await run(["send", "researcher", "Investigate NATS", "--follow-up"], env)
    assert.match(sent.stdout, /^Instruction accepted by researcher$/m)
    assert.match(sent.stdout, /^Delivery: followUp$/m)
    const commands = JSON.parse(await readFile(commandsFile, "utf8"))
    assert.deepEqual(commands.at(-1), {
      id: commands.at(-1).id,
      type: "prompt",
      message: "Investigate NATS",
      streamingBehavior: "followUp",
    })

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

test("receives and renders live activity through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-receive-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const env = {
    ...process.env,
    HOME: home,
    PI_FLEET_PI_COMMAND: fakePi,
    PI_FLEET_FAKE_PI_MODE: "semantic-events",
  }
  let createdId
  let receiver
  try {
    await chmod(fakePi, 0o755)
    const created = await run(["create", "researcher", "--cwd", process.cwd()], env)
    createdId = created.stdout.match(/^ID: (.+)$/m)?.[1]
    assert.ok(createdId)

    receiver = spawn(process.execPath, [pif, "receive", "researcher"], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    receiver.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    receiver.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    const exited = new Promise((resolve) => receiver.once("exit", (code, signal) => resolve({ code, signal })))

    await run(["send", "researcher", "Warmup one"], env)
    await run(["send", "researcher", "Warmup two"], env)
    await run(["send", "researcher", "CLI activity"], env)
    await waitForText(receiver, () => stdout, "Message finished: Handled: CLI activity")
    await waitForText(receiver, () => stdout, "Tool finished: bash")

    receiver.kill("SIGINT")
    assert.deepEqual(await exited, { code: 130, signal: null })
    assert.match(stdout, /^Thinking started\.$/m)
    assert.match(stdout, /^Thinking finished: I will check\.$/m)
    assert.match(stdout, /^Message started\.$/m)
    assert.match(stdout, /^Tool started: bash$/m)
    assert.match(stdout, /^  Params: {"command":"pwd"}$/m)
    assert.match(stdout, /^  Output:$/m)
    assert.match(stdout, /^    \/workspace$/m)
    assert.match(stdout, /^    second line$/m)
    assert.doesNotMatch(stdout, /\u001b/)
    assert.match(stdout, /^  Details: {"exitCode":0}$/m)
    assert.match(stdout, /^Cursor: pf1\.[A-Za-z0-9_-]+$/m)
    assert.equal(stderr, "")
  } finally {
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill("SIGTERM")
    if (createdId) await terminateWorker(stateDir, createdId)
    await rm(root, { recursive: true, force: true })
  }
})

test("renders durable interrupted work after Pi recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-recovery-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const piPidFile = join(root, "pi.pid")
  const settleFile = join(root, "settle")
  const env = {
    ...process.env,
    HOME: home,
    PI_FLEET_PI_COMMAND: fakePi,
    PI_FLEET_FAKE_PI_MODE: "prompt-event",
    PI_FLEET_FAKE_PI_PID_FILE: piPidFile,
    PI_FLEET_FAKE_PI_SETTLE_FILE: settleFile,
  }
  let createdId
  let receiver
  try {
    await chmod(fakePi, 0o755)
    const created = await run(["create", "researcher", "--cwd", process.cwd()], env)
    createdId = created.stdout.match(/^ID: (.+)$/m)?.[1]
    assert.ok(createdId)

    await run(["send", "researcher", "Start recoverable work"], env)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await run(["status", "researcher"], env)).stdout.includes("State: working")) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await run(["status", "researcher"], env)).stdout.includes("State: idle")) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    receiver = spawn(process.execPath, [pif, "receive", "researcher", "--from-start"], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    receiver.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    receiver.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    const exited = new Promise((resolve) => receiver.once("exit", (code, signal) => resolve({ code, signal })))
    await waitForText(receiver, () => stdout, "Work interrupted.")
    receiver.kill("SIGINT")
    assert.deepEqual(await exited, { code: 130, signal: null })
    assert.match(stdout, /^Work interrupted\.$/m)
    assert.match(stdout, /^Cursor: pf1\.[A-Za-z0-9_-]+$/m)
    assert.equal(stderr, "")
  } finally {
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill("SIGTERM")
    if (createdId) await terminateWorker(stateDir, createdId)
    await rm(root, { recursive: true, force: true })
  }
})

test("renders bounded tool errors without terminal control characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-bounded-output-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const env = {
    ...process.env,
    HOME: home,
    PI_FLEET_PI_COMMAND: fakePi,
    PI_FLEET_FAKE_PI_MODE: "semantic-bounded-error",
  }
  let createdId
  let receiver
  try {
    await chmod(fakePi, 0o755)
    const created = await run(["create", "researcher", "--cwd", process.cwd()], env)
    createdId = created.stdout.match(/^ID: (.+)$/m)?.[1]
    assert.ok(createdId)

    receiver = spawn(process.execPath, [pif, "receive", "researcher"], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    receiver.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    receiver.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    const exited = new Promise((resolve) => receiver.once("exit", (code, signal) => resolve({ code, signal })))

    await run(["send", "researcher", "Warmup"], env)
    await run(["send", "researcher", "Bounded error"], env)
    await waitForText(receiver, () => stdout, "Tool finished: bash unsafe with an error")

    receiver.kill("SIGINT")
    assert.deepEqual(await exited, { code: 130, signal: null })
    assert.match(stdout, /^Tool started: bash unsafe$/m)
    assert.match(stdout, /^  Params: \[omitted\]$/m)
    assert.match(stdout, /^  Output:$/m)
    assert.match(stdout, /^    command failed$/m)
    assert.match(stdout, /^    next line$/m)
    assert.match(stdout, /^  Output: \[image\/png unsafe omitted, 5 bytes\]$/m)
    assert.match(stdout, /^  Details: \[omitted\]$/m)
    assert.match(stdout, /^  Note: output was truncated or omitted\.$/m)
    assert.doesNotMatch(stdout, /\u001b|\r/)
    assert.equal(stderr, "")
  } finally {
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill("SIGTERM")
    if (createdId) await terminateWorker(stateDir, createdId)
    await rm(root, { recursive: true, force: true })
  }
})

test("lists agents in sorted fixed-width columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-list-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const env = { HOME: home }
  const registry = await openStore(stateDir)
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
  assert.match(help.stdout, /Usage: pif create \[options\] <name>/)
  assert.match(help.stdout, /--cwd <path>/)
  assert.match(help.stdout, /Arguments after -- pass through to Pi/)

  await assert.rejects(
    run(["receive", "researcher", "--from-start", "--after", "pf1.invalid"], {}),
    (error) => {
      assert.match(error.stderr, /option '--from-start' cannot be used with option '--after <cursor>'/)
      return true
    },
  )

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

test("replays and resumes durable activity through CLI receive options", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-cli-replay-"))
  const home = join(root, "home")
  const stateDir = join(home, ".pi-fleet")
  const env = {
    ...process.env,
    HOME: home,
    PI_FLEET_PI_COMMAND: fakePi,
    PI_FLEET_FAKE_PI_MODE: "semantic-events",
  }
  let createdId
  let replay
  let resumed
  try {
    await chmod(fakePi, 0o755)
    const created = await run(["create", "researcher", "--cwd", process.cwd()], env)
    createdId = created.stdout.match(/^ID: (.+)$/m)?.[1]
    assert.ok(createdId)
    await run(["send", "researcher", "Replay before"], env)

    replay = spawn(process.execPath, [pif, "receive", "researcher", "--from-start"], { env, stdio: ["ignore", "pipe", "pipe"] })
    let replayOutput = ""
    replay.stdout.setEncoding("utf8").on("data", (chunk) => { replayOutput += chunk })
    const replayExited = new Promise((resolve) => replay.once("exit", (code, signal) => resolve({ code, signal })))
    await waitForText(replay, () => replayOutput, "Message finished: Handled: Replay before")
    const cursor = [...replayOutput.matchAll(/^Cursor: (pf1\.[A-Za-z0-9_-]+)$/gm)].at(-1)?.[1]
    assert.ok(cursor)
    replay.kill("SIGINT")
    assert.deepEqual(await replayExited, { code: 130, signal: null })

    resumed = spawn(process.execPath, [pif, "receive", "researcher", "--after", cursor], { env, stdio: ["ignore", "pipe", "pipe"] })
    let resumedOutput = ""
    resumed.stdout.setEncoding("utf8").on("data", (chunk) => { resumedOutput += chunk })
    const resumedExited = new Promise((resolve) => resumed.once("exit", (code, signal) => resolve({ code, signal })))
    await run(["send", "researcher", "Replay after"], env)
    await waitForText(resumed, () => resumedOutput, "Message finished: Handled: Replay after")
    resumed.kill("SIGINT")
    assert.deepEqual(await resumedExited, { code: 130, signal: null })
    assert.match(resumedOutput, /^Cursor: pf1\.[A-Za-z0-9_-]+$/m)
  } finally {
    if (replay && replay.exitCode === null && replay.signalCode === null) replay.kill("SIGTERM")
    if (resumed && resumed.exitCode === null && resumed.signalCode === null) resumed.kill("SIGTERM")
    if (createdId) await terminateWorker(stateDir, createdId)
    await rm(root, { recursive: true, force: true })
  }
})
