import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { AgentNameTakenError } from "../dist/index.js"
import { createStateDirectories } from "../dist/internal/paths.js"
import { openRegistry } from "../dist/internal/registry.js"

const execFileAsync = promisify(execFile)

const record = (name, id) => ({
  id,
  name,
  cwd: "/work",
  instructions: "be concise",
  piArgs: ["--offline"],
  state: "starting",
  runtime: {
    generation: "runtime-1",
    state: "starting",
    endpoint: "ipc:///tmp/pi-fleet.sock",
  },
  lastEventSeq: 0,
  createdAt: 1,
  updatedAt: 1,
})

async function withRegistry(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-registry-"))
  const registry = await openRegistry(stateDir)
  try {
    await run(registry, stateDir)
  } finally {
    await registry.close()
    await rm(stateDir, { recursive: true, force: true })
  }
}

test("creates an agent and resolves it from the durable name index", async () => {
  await withRegistry(async (registry) => {
    const created = record("researcher", "agent-1")
    await registry.create(created)

    assert.deepEqual(await registry.getByName("researcher"), created)
    assert.deepEqual(await registry.getById("agent-1"), created)
    assert.deepEqual(await registry.list(), [{
      id: "agent-1",
      name: "researcher",
      cwd: "/work",
      state: "starting",
    }])
  })
})

test("atomically rejects a duplicate name", async () => {
  await withRegistry(async (registry) => {
    await registry.create(record("researcher", "agent-1"))

    await assert.rejects(
      registry.create(record("researcher", "agent-2")),
      AgentNameTakenError,
    )

    assert.equal((await registry.getByName("researcher"))?.id, "agent-1")
    assert.equal(await registry.getById("agent-2"), undefined)
  })
})

test("rolls back an incomplete creation so its name can be reused", async () => {
  await withRegistry(async (registry) => {
    await registry.create(record("researcher", "agent-1"))
    await registry.rollbackCreation("agent-1", "researcher", "runtime-1")

    assert.equal(await registry.getByName("researcher"), undefined)
    await registry.create(record("researcher", "agent-2"))
    assert.equal((await registry.getByName("researcher"))?.id, "agent-2")
  })
})

test("rolls back only the runtime generation created by the caller", async () => {
  await withRegistry(async (registry) => {
    await registry.create(record("researcher", "agent-1"))

    await registry.rollbackCreation("agent-1", "researcher", "wrong-runtime")
    assert.equal((await registry.getByName("researcher"))?.id, "agent-1")

    await registry.markReady("agent-1", "runtime-1", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    })
    await registry.rollbackCreation("agent-1", "researcher", "runtime-1")
    assert.equal(await registry.getByName("researcher"), undefined)
  })
})

test("allows only one concurrent creation for a name", async () => {
  await withRegistry(async (registry) => {
    const results = await Promise.allSettled([
      registry.create(record("researcher", "agent-1")),
      registry.create(record("researcher", "agent-2")),
    ])

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1)
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1)
    assert.match((await registry.getByName("researcher"))?.id ?? "", /^agent-[12]$/)
  })
})

test("allows only one creation across separate processes", async () => {
  await withRegistry(async (registry, stateDir) => {
    const registryUrl = new URL("../dist/internal/registry.js", import.meta.url).href
    const createScript = `
      import { openRegistry } from ${JSON.stringify(registryUrl)};
      const [stateDir, id] = process.argv.slice(1);
      const registry = await openRegistry(stateDir);
      try {
        await registry.create({
          id,
          name: "researcher",
          cwd: "/work",
          piArgs: [],
          state: "starting",
          runtime: { generation: id, state: "starting", endpoint: "ipc:///tmp/test.sock" },
          lastEventSeq: 0,
          createdAt: 1,
          updatedAt: 1,
        });
      } finally {
        await registry.close();
      }
    `
    const results = await Promise.allSettled([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", createScript, stateDir, "agent-a"]),
      execFileAsync(process.execPath, ["--input-type=module", "--eval", createScript, stateDir, "agent-b"]),
    ])

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1)
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1)
    assert.match(registry.getByName("researcher")?.id ?? "", /^agent-[ab]$/)
  })
})

test("repairs private directory permissions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-permissions-"))
  try {
    await chmod(stateDir, 0o755)
    await createStateDirectories(stateDir)

    assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
    assert.equal((await stat(join(stateDir, "ipc"))).mode & 0o777, 0o700)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("shares one environment through symlinked state paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-alias-"))
  const stateDir = join(root, "state")
  const alias = join(root, "alias")
  const first = await openRegistry(stateDir)
  try {
    await symlink(stateDir, alias)
    const second = await openRegistry(alias)
    await first.create(record("researcher", "agent-1"))
    await first.close()
    try {
      assert.equal(second.getByName("researcher")?.id, "agent-1")
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("reopens safely while the previous environment closes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-reopen-"))
  const first = await openRegistry(stateDir)
  await first.create(record("researcher", "agent-1"))
  const closing = first.close()
  const [second, third] = await Promise.all([openRegistry(stateDir), openRegistry(stateDir)])
  await closing
  try {
    assert.equal(second.getByName("researcher")?.id, "agent-1")
    assert.equal(third.getByName("researcher")?.id, "agent-1")
  } finally {
    await second.close()
    await third.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("marks only the claimed runtime generation ready", async () => {
  await withRegistry(async (registry) => {
    await registry.create(record("researcher", "agent-1"))

    assert.equal(await registry.markReady("agent-1", "wrong", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    }), false)

    assert.equal(await registry.markReady("agent-1", "runtime-1", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    }), true)

    assert.deepEqual(await registry.getById("agent-1"), {
      ...record("researcher", "agent-1"),
      state: "idle",
      runtime: {
        generation: "runtime-1",
        state: "ready",
        endpoint: "ipc:///tmp/worker.sock",
        workerPid: 123,
      },
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
      updatedAt: (await registry.getById("agent-1")).updatedAt,
    })
  })
})
