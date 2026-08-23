import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Router } from "zeromq"
import { AgentUnavailableError } from "../../dist/index.js"
import { decode, encode } from "../../dist/worker/protocol.js"
import { receiveEvents, requestSend, requestStatus } from "../../dist/worker/control.js"

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

async function withRouter(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-worker-client-"))
  const router = new Router({ linger: 0 })
  const endpoint = `ipc://${join(root, "worker.sock")}`
  await router.bind(endpoint)
  try {
    await run(router, record(endpoint))
  } finally {
    router.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("subscribes, yields events, and unsubscribes when iteration ends", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, subscribeFrame] = await router.receive()
      const subscribe = decode(subscribeFrame)
      assert.equal(subscribe.command, "subscribe")
      await router.send([route, encode({
        version: 1,
        requestId: subscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      await router.send([route, encode({
        version: 1,
        command: "event",
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        event: { type: "tool.finished", eventId: "event-1", activityId: "tool-1", timestamp: 1, toolName: "bash", isError: false },
      })])
      const [, unsubscribeFrame] = await router.receive()
      const unsubscribe = decode(unsubscribeFrame)
      assert.equal(unsubscribe.command, "unsubscribe")
      assert.equal(unsubscribe.subscriptionId, "subscription-1")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.next(), {
      value: { type: "tool.finished", eventId: "event-1", activityId: "tool-1", timestamp: 1, toolName: "bash", isError: false },
      done: false,
    })
    await iterator.return()
    await responder
  })
})

test("rejects a subscription with mismatched worker identity", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "subscribe",
        ok: true,
        agentId: "other-agent",
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
    })()

    await assert.rejects(receiveEvents(agent)[Symbol.asyncIterator]().next(), AgentUnavailableError)
    await responder
  })
})

test("ends a subscription normally when aborted", async () => {
  await withRouter(async (router, agent) => {
    let subscribed
    const receivedSubscribe = new Promise((resolve) => { subscribed = resolve })
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      subscribed()
      const [, unsubscribeFrame] = await router.receive()
      assert.equal(decode(unsubscribeFrame).command, "unsubscribe")
    })()

    const controller = new AbortController()
    const iterator = receiveEvents(agent, controller.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await receivedSubscribe
    controller.abort()
    assert.deepEqual(await next, { value: undefined, done: true })
    await responder
  })
})

test("rejects an idle subscription when the worker cannot answer a health probe", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      await router.receive()
    })()

    await assert.rejects(receiveEvents(agent)[Symbol.asyncIterator]().next(), AgentUnavailableError)
    await responder
  })
})

test("rejects a status response from the wrong agent identity", async () => {
  await withRouter(async (router, agent) => {
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

    await assert.rejects(requestStatus(agent, 500), AgentUnavailableError)
    await responder
  })
})

test("sends the message and returns a matching worker acknowledgement", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      assert.deepEqual({
        version: request.version,
        command: request.command,
        agentId: request.agentId,
        runtimeGeneration: request.runtimeGeneration,
        message: request.message,
        delivery: request.delivery,
      }, {
        version: 1,
        command: "send",
        agentId: "agent-1",
        runtimeGeneration: "runtime-1",
        message: "Investigate NATS",
        delivery: "followUp",
      })
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "send",
        ok: true,
        agentId: request.agentId,
        runtimeGeneration: request.runtimeGeneration,
        acceptedAt: 123,
      })])
    })()

    assert.deepEqual(await requestSend(agent, "Investigate NATS", "followUp", 500), { acceptedAt: 123 })
    await responder
  })
})

test("returns a valid worker rejection as a normal error", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "send",
        ok: false,
        agentId: request.agentId,
        runtimeGeneration: request.runtimeGeneration,
        error: "Pi rejected the prompt",
      })])
    })()

    await assert.rejects(requestSend(agent, "Investigate NATS", "steer", 500), {
      message: "Pi rejected the prompt",
    })
    await responder
  })
})

test("rejects a send response with the wrong worker identity", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      const [route, frame] = await router.receive()
      const request = decode(frame)
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "send",
        ok: true,
        agentId: "other-agent",
        runtimeGeneration: request.runtimeGeneration,
        acceptedAt: 123,
      })])
    })()

    await assert.rejects(requestSend(agent, "Investigate NATS", "steer", 500), AgentUnavailableError)
    await responder
  })
})
