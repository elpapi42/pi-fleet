import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { connectPiFleet, AgentRecoveryQueueFullError, AgentSendUncertainError, AgentUnavailableError } from "../../dist/index.js"
import { decodeEventCursor, openStore } from "../../dist/state/store.js"

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

async function replaceRuntimeGeneration(stateDir, id, generation) {
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
    import { open } from "lmdb";
    const [stateDir, id, generation] = process.argv.slice(1);
    const root = open({ path: stateDir, maxDbs: 3 });
    try {
      const agents = root.openDB("agents", { encoding: "json", useVersions: true });
      const entry = agents.getEntry(id);
      if (!entry?.value.runtime) throw new Error("Missing runtime");
      const version = entry.version ?? 0;
      await agents.put(id, { ...entry.value, runtime: { ...entry.value.runtime, generation } }, version + 1, version);
    } finally {
      await root.close();
    }
  `, stateDir, id, generation])
}


async function withState(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-recovery-"))
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

test("keeps serving status without an interruption event after an idle Pi exits", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const readyIncarnationFile = join(stateDir, "fake-pi-ready-incarnation")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE = readyIncarnationFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (Number(await readFile(readyIncarnationFile, "utf8")) >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal((await agent.status()).state, "idle")
      const registry = await openStore(stateDir)
      try {
        assert.equal(registry.getById(agent.id)?.lastEventSeq, 0)
      } finally {
        await registry.close()
      }
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE
      await client.close()
    }
  })
})

test("keeps a receive stream connected across a working Pi crash", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const settleFile = join(stateDir, "settle")
    process.env.PI_FLEET_FAKE_PI_MODE = "prompt-event"
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_SETTLE_FILE = settleFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const registry = await openStore(stateDir)
      const before = registry.getById(agent.id)
      await registry.close()
      assert.ok(before?.runtime?.workerPid)
      assert.ok(before?.runtime?.endpoint)

      const iterator = agent.receive()[Symbol.asyncIterator]()
      const interrupted = iterator.next()
      await agent.send("Start work")
      for (let attempt = 0; attempt < 40 && (await agent.status()).state !== "working"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal((await agent.status()).state, "working")
      const oldPiPid = Number(await readFile(piPidFile, "utf8"))
      process.kill(oldPiPid, "SIGTERM")

      const event = await interrupted
      assert.equal(event.value.type, "work.interrupted")
      assert.equal(decodeEventCursor(event.value.cursor).sequence, 1)
      const registryAfterCrash = await openStore(stateDir)
      const afterCrash = registryAfterCrash.getById(agent.id)
      await registryAfterCrash.close()
      assert.equal(afterCrash?.runtime?.workerPid, before.runtime.workerPid)
      assert.equal(afterCrash?.runtime?.endpoint, before.runtime.endpoint)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const newPiPid = Number(await readFile(piPidFile, "utf8"))
        if (newPiPid !== oldPiPid && (await agent.status()).state === "idle") break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal((await agent.status()).state, "idle")
      assert.notEqual(Number(await readFile(piPidFile, "utf8")), oldPiPid)
      const replay = agent.receive({ fromStart: true })[Symbol.asyncIterator]()
      assert.deepEqual((await replay.next()).value, event.value)
      await replay.return()
      await agent.send("Continue work")
      await writeFile(settleFile, "settle")
      await iterator.return()
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_SETTLE_FILE
      await client.close()
    }
  })
})

test("reports an uncertain send without retrying it after recovery", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const commandLog = join(stateDir, "fake-pi-command-log")
    process.env.PI_FLEET_FAKE_PI_MODE = "start-then-exit-on-prompt"
    process.env.PI_FLEET_FAKE_PI_EXIT_ON_PROMPT_INCARNATION = "1"
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE = commandLog
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "500"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const iterator = agent.receive()[Symbol.asyncIterator]()
      const interruption = iterator.next()
      await assert.rejects(agent.send("uncertain"), AgentSendUncertainError)
      const queued = agent.send("after recovery")
      assert.equal((await interruption).value.type, "work.interrupted")
      await queued
      assert.equal((await agent.status()).state, "idle")
      const prompts = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).request)
        .filter((request) => request.type === "prompt")
      assert.deepEqual(prompts.map(({ message }) => message), ["uncertain", "after recovery"])
      await iterator.return()
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      delete process.env.PI_FLEET_FAKE_PI_EXIT_ON_PROMPT_INCARNATION
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
      await client.close()
    }
  })
})

test("queues sends in order while an idle Pi restarts", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const commandLog = join(stateDir, "fake-pi-command-log")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE = commandLog
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "500"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          if (Number(await readFile(incarnationFile, "utf8")) >= 2) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(Number(await readFile(incarnationFile, "utf8")), 2)
      const first = agent.send("first")
      await new Promise((resolve) => setTimeout(resolve, 25))
      const second = agent.send("second", { delivery: "followUp" })
      await new Promise((resolve) => setTimeout(resolve, 25))
      const third = agent.send("third")
      const accepted = await Promise.all([first, second, third])
      assert.equal(accepted.every(({ acceptedAt }) => typeof acceptedAt === "number"), true)
      const prompts = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).request)
        .filter((request) => request.type === "prompt")
      assert.deepEqual(prompts.map((request) => request.message), ["first", "second", "third"])
      assert.deepEqual(prompts.map((request) => request.streamingBehavior), ["steer", "followUp", "steer"])
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_COMMAND_LOG_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
      await client.close()
    }
  })
})

test("exposes recovery queue overflow through the public agent handle", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const recoveryStartedFile = join(stateDir, "recovery-started")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE = recoveryStartedFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "500"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await readFile(recoveryStartedFile)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }

      let queueFull
      const sawQueueFull = new Promise((resolve) => { queueFull = resolve })
      const sends = Array.from({ length: 33 }, (_, index) => agent.send(`queued-${index}`).catch((error) => {
        if (error instanceof AgentRecoveryQueueFullError) queueFull()
        throw error
      }))
      const settled = Promise.allSettled(sends)
      await sawQueueFull
      const results = await settled
      assert.equal(results.filter(({ status, reason }) => status === "rejected" && reason instanceof AgentRecoveryQueueFullError).length, 1)
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 32)
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
      await client.close()
    }
  })
})

test("intentional worker shutdown does not interrupt work or restart Pi", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    process.env.PI_FLEET_FAKE_PI_MODE = "prompt-event"
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      await agent.send("work until shutdown")
      for (let attempt = 0; attempt < 80 && (await agent.status()).state !== "working"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await terminateWorker(stateDir, agent.id)
      const registry = await openStore(stateDir)
      try {
        assert.equal(registry.getById(agent.id)?.lastEventSeq, 0)
      } finally {
        await registry.close()
      }
      assert.equal(Number(await readFile(incarnationFile, "utf8")), 1)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_MODE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      await client.close()
    }
  })
})

test("stops a replacement Pi that loses the worker generation fence", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const recoveryStartedFile = join(stateDir, "recovery-started")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE = recoveryStartedFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "500"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      const registry = await openStore(stateDir)
      const workerPid = registry.getById(agent.id)?.runtime?.workerPid
      await registry.close()
      assert.ok(workerPid)
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await readFile(recoveryStartedFile)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      const replacementPid = Number(await readFile(piPidFile, "utf8"))
      await replaceRuntimeGeneration(stateDir, agent.id, "replacement-generation")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          process.kill(workerPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" })
      assert.throws(() => process.kill(replacementPid, 0), { code: "ESRCH" })
      assert.equal(Number(await readFile(incarnationFile, "utf8")), 2)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
      await client.close()
    }
  })
})

test("worker shutdown cancels a pending Pi restart", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const recoveryStartedFile = join(stateDir, "recovery-started")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE = recoveryStartedFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS = "5000"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await readFile(recoveryStartedFile)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      const replacementPid = Number(await readFile(piPidFile, "utf8"))
      await terminateWorker(stateDir, agent.id)
      assert.throws(() => process.kill(replacementPid, 0), { code: "ESRCH" })
      assert.equal(Number(await readFile(incarnationFile, "utf8")), 2)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_STARTED_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_DELAY_MS
      await client.close()
    }
  })
})

test("stops a crash-looping worker before a later operation replaces it", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    const readyIncarnationFile = join(stateDir, "fake-pi-ready-incarnation")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE = readyIncarnationFile
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      for (const expectedIncarnation of [2, 3]) {
        process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (Number(await readFile(readyIncarnationFile, "utf8")) >= expectedIncarnation) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.equal(Number(await readFile(readyIncarnationFile, "utf8")), expectedIncarnation)
        await agent.send(`ready-${expectedIncarnation}`)
      }

      const registry = await openStore(stateDir)
      const oldWorkerPid = registry.getById(agent.id)?.runtime?.workerPid
      await registry.close()
      assert.ok(oldWorkerPid)
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          process.kill(oldWorkerPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      assert.throws(() => process.kill(oldWorkerPid, 0), { code: "ESRCH" })
      assert.equal((await agent.status()).state, "idle")
      assert.equal(Number(await readFile(readyIncarnationFile, "utf8")), 4)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_READY_INCARNATION_FILE
      await client.close()
    }
  })
})

test("rejects silent fleet-owned session replacement but preserves caller session authority", { concurrency: false }, async () => {
  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_SESSION_ID = "replacement-session"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "researcher", cwd: process.cwd() })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await agent.status()
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await assert.rejects(agent.status(), AgentUnavailableError)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_SESSION_ID
      await client.close()
    }
  })

  await withState(async (stateDir) => {
    const piPidFile = join(stateDir, "fake-pi.pid")
    const incarnationFile = join(stateDir, "fake-pi-incarnation")
    process.env.PI_FLEET_FAKE_PI_PID_FILE = piPidFile
    process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE = incarnationFile
    process.env.PI_FLEET_FAKE_PI_RECOVERY_SESSION_ID = "caller-selected-replacement"
    const client = await connectPiFleet({ stateDir })
    try {
      const agent = await client.create({ name: "caller-session", cwd: process.cwd(), piArgs: ["--session", "/sessions/caller.jsonl"] })
      process.kill(Number(await readFile(piPidFile, "utf8")), "SIGTERM")
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (Number(await readFile(incarnationFile, "utf8")) >= 2 && (await agent.status()).state === "idle") break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal((await agent.status()).state, "idle")
      await terminateWorker(stateDir, agent.id)
    } finally {
      delete process.env.PI_FLEET_FAKE_PI_PID_FILE
      delete process.env.PI_FLEET_FAKE_PI_INCARNATION_FILE
      delete process.env.PI_FLEET_FAKE_PI_RECOVERY_SESSION_ID
      await client.close()
    }
  })
})
