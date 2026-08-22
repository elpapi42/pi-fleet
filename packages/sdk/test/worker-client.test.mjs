import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Router } from "zeromq"
import { AgentUnavailableError } from "../dist/index.js"
import { decode, encode } from "../dist/internal/protocol.js"
import { requestStatus } from "../dist/internal/worker-client.js"

const record = (endpoint) => ({
  id: "agent-1",
  name: "researcher",
  cwd: process.cwd(),
  piArgs: [],
  state: "idle",
  runtime: {
    generation: "runtime-1",
    state: "ready",
    endpoint,
    workerPid: process.pid,
  },
  lastEventSeq: 0,
  createdAt: 1,
  updatedAt: 1,
})

test("rejects a status response from the wrong agent identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-status-identity-"))
  const endpoint = `ipc://${join(root, "worker.sock")}`
  const router = new Router({ linger: 0 })
  await router.bind(endpoint)
  const responder = (async () => {
    const [route, frame] = await router.receive()
    const request = decode(frame)
    await router.send([route, encode({
      version: 1,
      requestId: request.requestId,
      ok: true,
      status: {
        id: "agent-2",
        name: "other",
        runtimeGeneration: "runtime-1",
        state: "idle",
      },
    })])
  })()

  try {
    await assert.rejects(requestStatus(record(endpoint), 500), AgentUnavailableError)
    await responder
  } finally {
    router.close()
    await rm(root, { recursive: true, force: true })
  }
})
