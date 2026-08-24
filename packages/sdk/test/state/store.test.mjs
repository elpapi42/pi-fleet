import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { resolveStateDir } from "../../dist/fleet/client.js"
import { decodeEventCursor, encodeEventCursor, openStore } from "../../dist/state/store.js"

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

test("claims an unavailable ready runtime without changing durable agent data", async () => {
  await withStore(async (store) => {
    const initial = {
      ...record("researcher", "agent-1"),
      state: "idle",
      sessionPath: "/tmp/session-1.jsonl",
      sessionId: "session-1",
      runtime: { ...record("researcher", "agent-1").runtime, state: "ready", workerPid: 123 },
    }
    await store.create(initial)

    const claim = await store.claimRuntime("agent-1", "runtime-1", {
      generation: "runtime-2",
      claimId: "claim-2",
      claimedAt: 100,
      endpoint: "ipc:///tmp/runtime-2.sock",
    }, (cursor) => ({ type: "work.interrupted", cursor }))

    assert.equal(claim?.record.runtime?.generation, "runtime-2")
    assert.equal(claim?.record.runtime?.state, "starting")
    assert.equal(claim?.record.runtime?.claimId, "claim-2")
    assert.equal(claim?.record.runtime?.claimedAt, 100)
    assert.equal(claim?.record.runtime?.endpoint, "ipc:///tmp/runtime-2.sock")
    assert.equal(claim?.record.runtime?.workerPid, 123)
    assert.equal(claim?.record.state, "idle")
    assert.equal(claim?.record.cwd, initial.cwd)
    assert.deepEqual(claim?.record.piArgs, initial.piArgs)
    assert.equal(claim?.record.sessionPath, initial.sessionPath)
    assert.equal(claim?.record.sessionId, initial.sessionId)
    assert.equal(claim?.record.lastEventSeq, 0)
    assert.equal(claim?.interruption, undefined)
  })
})

test("atomically appends an interruption when a working runtime is claimed", async () => {
  await withStore(async (store) => {
    await store.create({
      ...record("researcher", "agent-1"),
      state: "working",
      runtime: { ...record("researcher", "agent-1").runtime, state: "ready" },
    })
    const oldEvent = await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.started", cursor }))
    const claim = await store.claimRuntime("agent-1", "runtime-1", {
      generation: "runtime-2",
      claimId: "claim-2",
      claimedAt: 100,
      endpoint: "ipc:///tmp/runtime-2.sock",
    }, (cursor) => ({ type: "work.interrupted", cursor }))

    assert.equal(oldEvent?.sequence, 1)
    assert.deepEqual(claim?.interruption, {
      sequence: 2,
      cursor: encodeEventCursor("agent-1", 2),
      event: { type: "work.interrupted", cursor: encodeEventCursor("agent-1", 2) },
    })
    assert.equal(store.getById("agent-1")?.lastEventSeq, 2)
    assert.equal(await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.finished", cursor })), undefined)
    assert.deepEqual(store.readEvents("agent-1", 0, 2, 10).map(({ sequence }) => sequence), [1, 2])
  })
})

test("protects fresh claims and replaces stale or released claims", async () => {
  await withStore(async (store) => {
    await store.create({
      ...record("researcher", "agent-1"),
      runtime: { ...record("researcher", "agent-1").runtime, claimId: "claim-1", claimedAt: 100 },
    })
    const claim = (generation, claimId, claimedAt) => store.claimRuntime("agent-1", "runtime-1", {
      generation,
      claimId,
      claimedAt,
      endpoint: `ipc:///tmp/${generation}.sock`,
    }, (cursor) => ({ type: "work.interrupted", cursor }))

    assert.equal(await claim("runtime-2", "claim-2", 30_100), undefined)
    assert.equal((await claim("runtime-2", "claim-2", 30_101))?.record.runtime?.generation, "runtime-2")
    assert.equal(await store.releaseRuntimeClaim("agent-1", "runtime-2", "wrong-claim"), false)
    assert.equal(await store.releaseRuntimeClaim("agent-1", "runtime-2", "claim-2"), true)
    assert.equal((await store.claimRuntime("agent-1", "runtime-2", {
      generation: "runtime-3",
      claimId: "claim-3",
      claimedAt: 30_102,
      endpoint: "ipc:///tmp/runtime-3.sock",
    }, (cursor) => ({ type: "work.interrupted", cursor })))?.record.runtime?.generation, "runtime-3")
    assert.equal(await store.releaseRuntimeClaim("agent-1", "runtime-2", "claim-2"), false)
    assert.equal(await store.markClaimReady("agent-1", "runtime-2", "claim-2", {
      workerPid: 456,
      endpoint: "ipc:///tmp/worker-2.sock",
      sessionPath: "/tmp/session-2.jsonl",
      sessionId: "session-2",
    }), false)
  })
})

test("binds readiness and fences to the current generation and claim", async () => {
  await withStore(async (store) => {
    await store.create({ ...record("researcher", "agent-1"), state: "idle", runtime: { ...record("researcher", "agent-1").runtime, state: "ready" } })
    await store.claimRuntime("agent-1", "runtime-1", {
      generation: "runtime-2",
      claimId: "claim-2",
      claimedAt: 100,
      endpoint: "ipc:///tmp/runtime-2.sock",
    }, (cursor) => ({ type: "work.interrupted", cursor }))

    assert.equal(await store.markClaimReady("agent-1", "runtime-2", "wrong-claim", {
      workerPid: 456,
      endpoint: "ipc:///tmp/worker-2.sock",
      sessionPath: "/tmp/session-2.jsonl",
      sessionId: "session-2",
    }), false)
    assert.equal(store.isCurrentRuntimeClaim("agent-1", "runtime-2", "claim-2"), true)
    assert.equal(await store.markClaimReady("agent-1", "runtime-2", "claim-2", {
      workerPid: 456,
      endpoint: "ipc:///tmp/worker-2.sock",
      sessionPath: "/tmp/session-2.jsonl",
      sessionId: "session-2",
    }), true)
    assert.equal(store.isCurrentRuntimeClaim("agent-1", "runtime-2", "claim-2"), true)
    assert.equal((await store.getById("agent-1"))?.state, "idle")
    assert.equal(await store.markClaimReady("agent-1", "runtime-2", "claim-2", {
      workerPid: 789,
      endpoint: "ipc:///tmp/worker-3.sock",
      sessionPath: "/tmp/session-3.jsonl",
      sessionId: "session-3",
    }), false)
  })
})

test("allows only one replacement claim across separate processes", async () => {
  await withStore(async (store, stateDir) => {
    await store.create({ ...record("researcher", "agent-1"), state: "idle", runtime: { ...record("researcher", "agent-1").runtime, state: "ready" } })
    const storeUrl = new URL("../../dist/state/store.js", import.meta.url).href
    const readyDir = join(stateDir, "claim-ready")
    const goFile = join(stateDir, "claim-go")
    const claimScript = `
      import { access, mkdir, writeFile } from "node:fs/promises";
      import { openStore } from ${JSON.stringify(storeUrl)};
      const [stateDir, readyDir, goFile, generation, claimId] = process.argv.slice(1);
      const store = await openStore(stateDir);
      try {
        await mkdir(readyDir, { recursive: true });
        await writeFile(readyDir + "/" + process.pid, "ready");
        while (true) {
          try { await access(goFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
        const result = await store.claimRuntime("agent-1", "runtime-1", {
          generation, claimId, claimedAt: 100, endpoint: "ipc:///tmp/" + generation + ".sock",
        }, (cursor) => ({ type: "work.interrupted", cursor }));
        process.stdout.write(String(result !== undefined));
      } finally {
        await store.close();
      }
    `
    const first = execFileAsync(process.execPath, ["--input-type=module", "--eval", claimScript, stateDir, readyDir, goFile, "runtime-2a", "claim-2a"])
    const second = execFileAsync(process.execPath, ["--input-type=module", "--eval", claimScript, stateDir, readyDir, goFile, "runtime-2b", "claim-2b"])

    for (let attempts = 0; attempts < 100; attempts += 1) {
      try {
        if ((await readdir(readyDir)).length === 2) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal((await readdir(readyDir)).length, 2)
    await writeFile(goFile, "go")

    const results = await Promise.all([first, second])
    assert.deepEqual(results.map(({ stdout }) => stdout).sort(), ["false", "true"])
    assert.match(store.getById("agent-1")?.runtime?.generation ?? "", /^runtime-2[ab]$/)
  })
})

test("records recovered Pi session identity and settles interrupted work", async () => {
  await withStore(async (store) => {
    await store.create({ ...record("researcher", "agent-1"), state: "working" })

    assert.equal(await store.markRecovered("agent-1", "wrong-runtime", {
      sessionPath: "/tmp/wrong.jsonl",
      sessionId: "wrong-session",
    }), false)
    assert.equal(await store.markRecovered("agent-1", "runtime-1", {
      sessionPath: "/tmp/recovered.jsonl",
      sessionId: "recovered-session",
    }), true)

    const recovered = store.getById("agent-1")
    assert.equal(recovered?.state, "idle")
    assert.equal(recovered?.sessionPath, "/tmp/recovered.jsonl")
    assert.equal(recovered?.sessionId, "recovered-session")
    assert.equal(recovered?.runtime?.generation, "runtime-1")
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

test("atomically appends ordered events for the claimed runtime generation", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    const first = await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.started", cursor }))
    const second = await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.finished", cursor }))

    assert.deepEqual(first, {
      sequence: 1,
      cursor: first.cursor,
      event: { type: "message.started", cursor: first.cursor },
    })
    assert.deepEqual(decodeEventCursor(first.cursor), { agentId: "agent-1", sequence: 1 })
    assert.equal(second.sequence, 2)
    assert.equal((await store.getById("agent-1"))?.lastEventSeq, 2)
    assert.deepEqual(store.readEvents("agent-1", 0, 2), [first, second])
    assert.deepEqual(store.readEvents("agent-1", 1, 2), [second])
  })
})

test("reads durable events in finite agent-scoped batches", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))
    await store.create(record("writer", "agent-2"))
    for (let index = 1; index <= 3; index += 1) {
      await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.started", cursor, index }))
    }
    await store.appendEvent("agent-2", "runtime-1", (cursor) => ({ type: "message.started", cursor, index: 99 }))

    assert.deepEqual(store.readEvents("agent-1", 0, 3, 1).map(({ sequence }) => sequence), [1])
    assert.deepEqual(store.readEvents("agent-1", 1, 3, 1).map(({ sequence }) => sequence), [2])
    assert.deepEqual(store.readEvents("agent-1", 2, 3, 1).map(({ sequence }) => sequence), [3])
    assert.deepEqual(store.readEvents("agent-1", 3, 3, 1), [])
  })
})

test("rejects noncanonical and oversized event cursors", () => {
  const cursor = encodeEventCursor("agent-1", 1)
  assert.deepEqual(decodeEventCursor(cursor), { agentId: "agent-1", sequence: 1 })
  for (const invalid of [`${cursor}!!!`, `${cursor}=`, `pf1.${"a".repeat(4097)}`]) {
    assert.throws(() => decodeEventCursor(invalid), { message: "Invalid event cursor" })
  }
})

test("does not append an event for another runtime generation", async () => {
  await withStore(async (store) => {
    await store.create(record("researcher", "agent-1"))

    assert.equal(await store.appendEvent("agent-1", "wrong-runtime", () => ({ type: "message.started" })), undefined)
    assert.equal((await store.getById("agent-1"))?.lastEventSeq, 0)
    assert.deepEqual(store.readEvents("agent-1", 0, 1), [])
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

test("atomically admits destroy with a final event and immediate name reuse", async () => {
  await withStore(async (store) => {
    await store.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: {
        ...record("researcher", "agent-old").runtime,
        state: "ready",
        claimId: "claim-old",
      },
    })

    const destroyed = await store.beginDestroy("agent-old", "researcher", {
      runtimeGeneration: "runtime-1",
      claimId: "claim-old",
      requestedAt: 100,
    }, (cursor) => ({ type: "agent.destroyed", cursor }))

    assert.deepEqual(destroyed?.event, {
      sequence: 1,
      cursor: encodeEventCursor("agent-old", 1),
      event: { type: "agent.destroyed", cursor: encodeEventCursor("agent-old", 1) },
    })
    assert.equal(destroyed?.record.destroying?.requestedAt, 100)
    assert.equal(destroyed?.record.destroying?.cleanupAfter, 30_100)
    assert.equal(destroyed?.record.destroying?.runtimeGeneration, "runtime-1")
    assert.equal(destroyed?.record.destroying?.claimId, "claim-old")
    assert.equal(store.getByName("researcher"), undefined)
    assert.equal(store.getById("agent-old")?.lastEventSeq, 1)
    assert.deepEqual(store.readEvents("agent-old", 0, 1, 10), [destroyed?.event])

    assert.equal(await store.create(record("researcher", "agent-new")), true)
    assert.equal(store.getByName("researcher")?.id, "agent-new")
  })
})

test("fences runtime mutations and recovery claims after destroy admission", async () => {
  await withStore(async (store) => {
    await store.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: {
        ...record("researcher", "agent-old").runtime,
        state: "ready",
        claimId: "claim-old",
      },
    })
    await store.beginDestroy("agent-old", "researcher", {
      runtimeGeneration: "runtime-1",
      claimId: "claim-old",
      requestedAt: 100,
    }, (cursor) => ({ type: "agent.destroyed", cursor }))

    assert.equal(await store.markReady("agent-old", "runtime-1", {
      workerPid: 1, endpoint: "ipc:///tmp/worker.sock", sessionPath: "/tmp/session", sessionId: "session",
    }), false)
    assert.equal(await store.markRecovered("agent-old", "runtime-1", { sessionPath: "/tmp/session", sessionId: "session" }), false)
    assert.equal(await store.updateState("agent-old", "runtime-1", "working"), false)
    assert.equal(await store.appendEvent("agent-old", "runtime-1", () => ({ type: "message.started" })), undefined)
    assert.equal(await store.claimRuntime("agent-old", "runtime-1", {
      generation: "runtime-2", claimId: "claim-2", claimedAt: 200, endpoint: "ipc:///tmp/runtime-2.sock",
    }, (cursor) => ({ type: "work.interrupted", cursor })), undefined)
    assert.equal(store.isCurrentRuntimeClaim("agent-old", "runtime-1", "claim-old"), false)
  })
})

test("deletes marked event history in finite batches and resumes only after its lease", async () => {
  await withStore(async (store, stateDir) => {
    const requestedAt = Date.now()
    await store.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: { ...record("researcher", "agent-old").runtime, state: "ready", claimId: "claim-old" },
    })
    await store.appendEvent("agent-old", "runtime-1", (cursor) => ({ type: "message.started", cursor }))
    await store.appendEvent("agent-old", "runtime-1", (cursor) => ({ type: "message.finished", cursor }))
    const destroy = await store.beginDestroy("agent-old", "researcher", {
      runtimeGeneration: "runtime-1", claimId: "claim-old", requestedAt,
    }, (cursor) => ({ type: "agent.destroyed", cursor }))
    assert.ok(destroy)

    assert.equal(await store.cleanupExpiredDestroys(requestedAt), 0)
    assert.ok(store.getById("agent-old"))
    assert.equal(await store.deleteDestroyEventBatch("agent-old", destroy.record.destroying, 2), 2)
    assert.ok(store.getById("agent-old"))
    assert.deepEqual(store.readEvents("agent-old", 0, 3, 10).map(({ sequence }) => sequence), [3])
    assert.equal(await store.finishDestroy("agent-old", destroy.record.destroying), false)

    await store.close()
    const reopened = await openStore(stateDir)
    try {
      assert.ok(reopened.getById("agent-old"))
      assert.equal(await reopened.cleanupExpiredDestroys(destroy.record.destroying.cleanupAfter), 1)
      assert.equal(reopened.getById("agent-old"), undefined)
    } finally {
      await reopened.close()
    }
  })
})

test("expired destroy cleanup removes only an owned IPC endpoint", async () => {
  await withStore(async (store, stateDir) => {
    const ipcDirectory = join(stateDir, "ipc")
    const endpointPath = join(ipcDirectory, "old.sock")
    await writeFile(endpointPath, "stale")
    await store.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: {
        ...record("researcher", "agent-old").runtime,
        state: "ready",
        claimId: "claim-old",
        endpoint: `ipc://${endpointPath}`,
      },
    })
    const destroy = await store.beginDestroy("agent-old", "researcher", {
      runtimeGeneration: "runtime-1", claimId: "claim-old", requestedAt: 100,
    }, (cursor) => ({ type: "agent.destroyed", cursor }))
    assert.ok(destroy)

    assert.equal(await store.cleanupExpiredDestroys(30_100), 1)
    await assert.rejects(stat(endpointPath), { code: "ENOENT" })
  })
})

test("store open resumes expired destroy cleanup but not a live lease", { concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-fleet-destroy-open-"))
  const first = await openStore(stateDir)
  try {
    await first.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: { ...record("researcher", "agent-old").runtime, state: "ready", claimId: "claim-old" },
    })
    await first.beginDestroy("agent-old", "researcher", {
      runtimeGeneration: "runtime-1", claimId: "claim-old", requestedAt: 100,
    }, (cursor) => ({ type: "agent.destroyed", cursor }))
  } finally {
    await first.close()
  }

  const originalNow = Date.now
  try {
    Date.now = () => 30_099
    const beforeLease = await openStore(stateDir)
    try {
      assert.ok(beforeLease.getById("agent-old"))
    } finally {
      await beforeLease.close()
    }

    Date.now = () => 30_100
    const afterLease = await openStore(stateDir)
    try {
      assert.equal(afterLease.getById("agent-old"), undefined)
    } finally {
      await afterLease.close()
    }
  } finally {
    Date.now = originalNow
    await rm(stateDir, { recursive: true, force: true })
  }
})

test("admits only one destroy across separate processes", async () => {
  await withStore(async (store, stateDir) => {
    await store.create({
      ...record("researcher", "agent-old"),
      state: "idle",
      runtime: { ...record("researcher", "agent-old").runtime, state: "ready", claimId: "claim-old" },
    })
    const storeUrl = new URL("../../dist/state/store.js", import.meta.url).href
    const readyDir = join(stateDir, "destroy-ready")
    const goFile = join(stateDir, "destroy-go")
    const destroyScript = `
      import { access, mkdir, writeFile } from "node:fs/promises";
      import { openStore } from ${JSON.stringify(storeUrl)};
      const [stateDir, readyDir, goFile] = process.argv.slice(1);
      const store = await openStore(stateDir);
      try {
        await mkdir(readyDir, { recursive: true });
        await writeFile(readyDir + "/" + process.pid, "ready");
        while (true) {
          try { await access(goFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
        const result = await store.beginDestroy("agent-old", "researcher", {
          runtimeGeneration: "runtime-1", claimId: "claim-old", requestedAt: 100,
        }, (cursor) => ({ type: "agent.destroyed", cursor }));
        process.stdout.write(String(result !== undefined));
      } finally {
        await store.close();
      }
    `
    const first = execFileAsync(process.execPath, ["--input-type=module", "--eval", destroyScript, stateDir, readyDir, goFile])
    const second = execFileAsync(process.execPath, ["--input-type=module", "--eval", destroyScript, stateDir, readyDir, goFile])
    for (let attempts = 0; attempts < 100; attempts += 1) {
      try {
        if ((await readdir(readyDir)).length === 2) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal((await readdir(readyDir)).length, 2)
    await writeFile(goFile, "go")
    assert.deepEqual((await Promise.all([first, second])).map(({ stdout }) => stdout).sort(), ["false", "true"])
    assert.equal(store.getByName("researcher"), undefined)
    assert.equal(store.getById("agent-old")?.lastEventSeq, 1)
    assert.equal(store.readEvents("agent-old", 0, 1, 10).length, 1)
  })
})

test("allocates each durable event sequence once across processes", async () => {
  await withStore(async (store, stateDir) => {
    await store.create(record("researcher", "agent-1"))
    const storeUrl = new URL("../../dist/state/store.js", import.meta.url).href
    const appendScript = `
      import { openStore } from ${JSON.stringify(storeUrl)};
      const [stateDir, value] = process.argv.slice(1);
      const store = await openStore(stateDir);
      try {
        const entry = await store.appendEvent("agent-1", "runtime-1", (cursor) => ({ type: "message.started", cursor, value }));
        process.stdout.write(String(entry.sequence));
      } finally {
        await store.close();
      }
    `
    const results = await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", appendScript, stateDir, "one"]),
      execFileAsync(process.execPath, ["--input-type=module", "--eval", appendScript, stateDir, "two"]),
    ])
    assert.deepEqual(results.map(({ stdout }) => Number(stdout)).sort(), [1, 2])
    assert.equal(store.getById("agent-1")?.lastEventSeq, 2)
    assert.deepEqual(store.readEvents("agent-1", 0, 2, 10).map(({ sequence }) => sequence), [1, 2])
  })
})
