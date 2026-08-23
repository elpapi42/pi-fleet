import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Router } from "zeromq"
import { AgentUnavailableError } from "../../dist/index.js"
import { decode, encode } from "../../dist/worker/protocol.js"
import { receiveEvents } from "../../dist/worker/stream.js"

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
        sequence: 1,
        event: {
          type: "tool.finished",
          cursor: "pf1.test-1",
          eventId: "event-1",
          activityId: "tool-1",
          timestamp: 1,
          toolName: "bash",
          isError: false,
          output: { content: [{ type: "text", text: "/workspace" }], detailsTruncated: false, truncated: false },
        },
      })])
      const [, unsubscribeFrame] = await router.receive()
      const unsubscribe = decode(unsubscribeFrame)
      assert.equal(unsubscribe.command, "unsubscribe")
      assert.equal(unsubscribe.subscriptionId, "subscription-1")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.next(), {
      value: {
        type: "tool.finished",
        cursor: "pf1.test-1",
        eventId: "event-1",
        activityId: "tool-1",
        timestamp: 1,
        toolName: "bash",
        isError: false,
        output: { content: [{ type: "text", text: "/workspace" }], detailsTruncated: false, truncated: false },
      },
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

    const stream = receiveEvents(agent)
    const next = stream.next()
    await receivedSubscribe
    await stream.close()
    assert.deepEqual(await next, { value: undefined, done: true })
    await responder
  })
})

test("cancels a worker subscription before acknowledgement", async () => {
  await withRouter(async (router, agent) => {
    let subscribed
    const receivedSubscribe = new Promise((resolve) => { subscribed = resolve })
    const responder = (async () => {
      await router.receive()
      subscribed()
      const [, unsubscribeFrame] = await router.receive()
      const unsubscribe = decode(unsubscribeFrame)
      assert.equal(unsubscribe.command, "unsubscribe")
      assert.equal(unsubscribe.subscriptionId, undefined)
    })()

    const stream = receiveEvents(agent)
    const next = stream.next()
    await receivedSubscribe
    await stream.close()
    assert.deepEqual(await next, { value: undefined, done: true })
    await responder
  })
})

test("rejects a subscription the worker reports as removed", async () => {
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
      const [, probeFrame] = await router.receive()
      const probe = decode(probeFrame)
      assert.equal(probe.command, "subscription.status")
      await router.send([route, encode({
        version: 1,
        requestId: probe.requestId,
        command: "subscription.status",
        ok: false,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        error: "Subscription is no longer active",
      })])
    })()

    await assert.rejects(receiveEvents(agent).next(), AgentUnavailableError)
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
      const [, probeFrame] = await router.receive()
      assert.equal(decode(probeFrame).command, "subscription.status")
    })()

    await assert.rejects(receiveEvents(agent)[Symbol.asyncIterator]().next(), AgentUnavailableError)
    await responder
  })
})

test("repairs an inactive subscription before its first event from the acknowledged cursor", async () => {
  await withRouter(async (router, agent) => {
    const event = {
      version: 1,
      command: "event",
      agentId: agent.id,
      runtimeGeneration: agent.runtime.generation,
      subscriptionId: "subscription-2",
      sequence: 2,
      event: {
        type: "message.started",
        cursor: "pf1.test-2",
        eventId: "event-2",
        activityId: "activity-2",
        timestamp: 2,
      },
    }
    const responder = (async () => {
      const [firstRoute, firstSubscribeFrame] = await router.receive()
      const firstSubscribe = decode(firstSubscribeFrame)
      assert.equal(firstSubscribe.command, "subscribe")
      assert.equal(firstSubscribe.after, undefined)
      await router.send([firstRoute, encode({
        version: 1,
        requestId: firstSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        afterSequence: 1,
        resumeCursor: "pf1.test-1",
      })])
      const [, probeFrame] = await router.receive()
      const probe = decode(probeFrame)
      assert.equal(probe.command, "subscription.status")
      await router.send([firstRoute, encode({
        version: 1,
        requestId: probe.requestId,
        command: "subscription.status",
        ok: false,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        error: "Subscription is no longer active",
      })])
      const [, firstUnsubscribeFrame] = await router.receive()
      assert.equal(decode(firstUnsubscribeFrame).command, "unsubscribe")

      const [secondRoute, secondSubscribeFrame] = await router.receive()
      const secondSubscribe = decode(secondSubscribeFrame)
      assert.equal(secondSubscribe.command, "subscribe")
      assert.equal(secondSubscribe.after, "pf1.test-1")
      await router.send([secondRoute, encode({
        version: 1,
        requestId: secondSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-2",
        afterSequence: 1,
        resumeCursor: "pf1.test-1",
      })])
      await router.send([secondRoute, encode(event)])
      const [, secondUnsubscribeFrame] = await router.receive()
      assert.equal(decode(secondUnsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, "pf1.test-2")
    await iterator.return()
    await responder
  })
})

test("repairs one sequence gap from the last delivered cursor", async () => {
  await withRouter(async (router, agent) => {
    const event = (sequence) => ({
      version: 1,
      command: "event",
      agentId: agent.id,
      runtimeGeneration: agent.runtime.generation,
      subscriptionId: "subscription-1",
      sequence,
      event: {
        type: "message.started",
        cursor: `pf1.test-${sequence}`,
        eventId: `event-${sequence}`,
        activityId: `activity-${sequence}`,
        timestamp: sequence,
      },
    })
    const responder = (async () => {
      const [firstRoute, firstSubscribeFrame] = await router.receive()
      const firstSubscribe = decode(firstSubscribeFrame)
      await router.send([firstRoute, encode({
        version: 1,
        requestId: firstSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      await router.send([firstRoute, encode(event(1))])
      await router.send([firstRoute, encode(event(3))])
      const [, firstUnsubscribeFrame] = await router.receive()
      assert.equal(decode(firstUnsubscribeFrame).command, "unsubscribe")

      const [secondRoute, secondSubscribeFrame] = await router.receive()
      const secondSubscribe = decode(secondSubscribeFrame)
      assert.equal(secondSubscribe.command, "subscribe")
      assert.equal(secondSubscribe.after, "pf1.test-1")
      await router.send([secondRoute, encode({
        version: 1,
        requestId: secondSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      await router.send([secondRoute, encode(event(2))])
      await router.send([secondRoute, encode(event(3))])
      const [, secondUnsubscribeFrame] = await router.receive()
      assert.equal(decode(secondUnsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, "pf1.test-1")
    assert.equal((await iterator.next()).value.cursor, "pf1.test-2")
    assert.equal((await iterator.next()).value.cursor, "pf1.test-3")
    await iterator.return()
    await responder
  })
})
