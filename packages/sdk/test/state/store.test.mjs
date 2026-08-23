import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { resolveStateDir } from "../../dist/fleet/client.js"
import { openStore } from "../../dist/state/store.js"

const execFileAsync = promisify(execFile)

const record = (name, id) => ({
  id,
  name,
  cwd: "/work",
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

async function withStore(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-store-"))
  const store = await openStore(stateDir)
  try {
    await run(store, stateDir)
  } finally {
    await store.close()
    await rm(stateDir, { recursive: true, force: true })
  }
}

test("uses ~/.pi-fleet as the default state directory regardless of XDG_STATE_HOME", { concurrency: false }, () => {
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = "/tmp/other-state-home"
  try {
    assert.equal(resolveStateDir(), join(homedir(), ".pi-fleet"))
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})

test("creates an agent and resolves it from the durable name index", async () => {
  await withStore(async (store) => {
    const created = record("researcher", "agent-1")
    await store.create(created)

    assert.deepEqual(await store.getByName("researcher"), created)
    assert.deepEqual(await store.getById("agent-1"), created)
    assert.deepEqual(await store.list(), [created])
  })
})

test("atomically rejects a duplicate name", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    assert.equal(await store.create(record("researcher", "agent-2")), false)

    assert.equal((await store.getByName("researcher"))?.id, "agent-1")
    assert.equal(await store.getById("agent-2"), undefined)
  })
})

test("rolls back an incomplete creation so its name can be reused", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))
    await store.rollbackCreation("agent-1", "researcher", "runtime-1")

    assert.equal(await store.getByName("researcher"), undefined)
    await store.create(record("researcher", "agent-2"))
    assert.equal((await store.getByName("researcher"))?.id, "agent-2")
  })
})

test("rolls back only the runtime generation created by the caller", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    await store.rollbackCreation("agent-1", "researcher", "wrong-runtime")
    assert.equal((await store.getByName("researcher"))?.id, "agent-1")

    await store.markReady("agent-1", "runtime-1", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    })
    await store.rollbackCreation("agent-1", "researcher", "runtime-1")
    assert.equal(await store.getByName("researcher"), undefined)
  })
})

test("allows only one concurrent creation for a name", async () => {
  await withStore(async (store) => {
    const results = await Promise.all([
      store.create(record("researcher", "agent-1")),
      store.create(record("researcher", "agent-2")),
    ])

    assert.equal(results.filter(Boolean).length, 1)
    assert.match((await store.getByName("researcher"))?.id ?? "", /^agent-[12]$/)
  })
})

test("allows only one creation across separate processes", async () => {
  await withStore(async (store, stateDir) => {
    const storeUrl = new URL("../../dist/state/store.js", import.meta.url).href
    const createScript = `
      import { openStore } from ${JSON.stringify(storeUrl)};
      const [stateDir, id] = process.argv.slice(1);
      const store = await openStore(stateDir);
      try {
        const created = await store.create({
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
        if (!created) throw new Error("Name already exists");
      } finally {
        await store.close();
      }
    `
    const results = await Promise.allSettled([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", createScript, stateDir, "agent-a"]),
      execFileAsync(process.execPath, ["--input-type=module", "--eval", createScript, stateDir, "agent-b"]),
    ])

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1)
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1)
    assert.match(store.getByName("researcher")?.id ?? "", /^agent-[ab]$/)
  })
})

test("repairs private directory permissions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-permissions-"))
  try {
    await chmod(stateDir, 0o755)
    await openStore(stateDir).then((store) => store.close())

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
  const first = await openStore(stateDir)
  try {
    await symlink(stateDir, alias)
    const second = await openStore(alias)
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
  const first = await openStore(stateDir)
  await first.create(record("researcher", "agent-1"))
  const closing = first.close()
  const [second, third] = await Promise.all([openStore(stateDir), openStore(stateDir)])
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
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    assert.equal(await store.markReady("agent-1", "wrong", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    }), false)

    assert.equal(await store.markReady("agent-1", "runtime-1", {
      workerPid: 123,
      endpoint: "ipc:///tmp/worker.sock",
      sessionPath: "/tmp/session.jsonl",
      sessionId: "session-1",
    }), true)

    assert.deepEqual(await store.getById("agent-1"), {
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
      updatedAt: (await store.getById("agent-1")).updatedAt,
    })
  })
})

test("updates state only for the claimed runtime generation", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    assert.equal(await store.updateState("agent-1", "runtime-1", "working"), true)
    assert.equal((await store.getById("agent-1"))?.state, "working")

    assert.equal(await store.updateState("agent-1", "wrong-runtime", "idle"), false)
    assert.equal((await store.getById("agent-1"))?.state, "working")

    assert.equal(await store.updateState("missing", "runtime-1", "idle"), false)
  })
})

test("does not rewrite an agent state that already matches", async () => {
  await withStore(async (store) => {
    await store.create({ ...record("researcher", "agent-1"), state: "working", updatedAt: 1 })

    assert.equal(await store.updateState("agent-1", "runtime-1", "working"), true)
    assert.equal((await store.getById("agent-1"))?.updatedAt, 1)
  })
})

test("handles concurrent state writes from separate processes", async () => {
  await withStore(async (store, stateDir) => {
    await store.create(record("researcher", "agent-1"))
    const storeUrl = new URL("../../dist/state/store.js", import.meta.url).href
    const readyDir = join(stateDir, "ready")
    const goFile = join(stateDir, "go")
    const updateScript = `
      import { mkdir, writeFile, access } from "node:fs/promises";
      import { openStore } from ${JSON.stringify(storeUrl)};
      const [stateDir, readyFile, goFile, state] = process.argv.slice(1);
      const store = await openStore(stateDir);
      try {
        await mkdir(readyFile, { recursive: true });
        await writeFile(readyFile + "/" + process.pid, "ready");
        while (true) {
          try { await access(goFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
        process.stdout.write(String(await store.updateState("agent-1", "runtime-1", state)));
      } finally {
        await store.close();
      }
    `
    const first = execFileAsync(process.execPath, ["--input-type=module", "--eval", updateScript, stateDir, readyDir, goFile, "working"])
    const second = execFileAsync(process.execPath, ["--input-type=module", "--eval", updateScript, stateDir, readyDir, goFile, "idle"])

    for (let attempts = 0; attempts < 100; attempts += 1) {
      try {
        if ((await readdir(readyDir)).length === 2) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal((await readdir(readyDir)).length, 2)
    await writeFile(goFile, "go")

    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult.stdout, "true")
    assert.equal(secondResult.stdout, "true")
    assert.match((await store.getById("agent-1"))?.state ?? "", /^(working|idle)$/)
  })
})
