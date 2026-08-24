import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Router } from "zeromq"
import { AgentUnavailableError } from "../../dist/index.js"
import { encodeEventCursor } from "../../dist/state/store.js"
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

function messageEvent(agent, subscriptionId, sequence) {
  return {
    version: 1,
    command: "event",
    agentId: agent.id,
    runtimeGeneration: agent.runtime.generation,
    subscriptionId,
    sequence,
    event: {
      type: "message.started",
      cursor: encodeEventCursor(agent.id, sequence),
      eventId: `event-${sequence}`,
      activityId: `activity-${sequence}`,
      timestamp: sequence,
    },
  }
}

async function withReplacementRouters(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-worker-replacement-"))
  const first = new Router({ linger: 0 })
  const second = new Router({ linger: 0 })
  const firstRecord = record(`ipc://${join(root, "first.sock")}`)
  const secondRecord = {
    ...record(`ipc://${join(root, "second.sock")}`),
    runtime: { ...record("").runtime, generation: "runtime-2", endpoint: `ipc://${join(root, "second.sock")}` },
  }
  await first.bind(firstRecord.runtime.endpoint)
  await second.bind(secondRecord.runtime.endpoint)
  try {
    await run(first, second, firstRecord, secondRecord)
  } finally {
    first.close()
    second.close()
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
        afterSequence: 0,
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
          cursor: encodeEventCursor(agent.id, 1),
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
        cursor: encodeEventCursor(agent.id, 1),
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

test("ends normally after an ordered stream terminal", async () => {
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
        afterSequence: 0,
      })])
      await router.send([route, encode({
        version: 1,
        command: "event",
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        sequence: 1,
        event: {
          type: "agent.destroyed",
          cursor: encodeEventCursor(agent.id, 1),
          eventId: "event-1",
          activityId: "destroy-1",
          timestamp: 1,
        },
      })])
      await router.send([route, encode({
        version: 1,
        command: "stream.end",
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
      })])
      const [, unsubscribeFrame] = await router.receive()
      assert.equal(decode(unsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.type, "agent.destroyed")
    assert.deepEqual(await iterator.next(), { value: undefined, done: true })
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
        afterSequence: 0,
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
        afterSequence: 0,
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
        afterSequence: 0,
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
        afterSequence: 0,
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
        cursor: encodeEventCursor(agent.id, 2),
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
        resumeCursor: encodeEventCursor(agent.id, 1),
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
      assert.equal(secondSubscribe.after, encodeEventCursor(agent.id, 1))
      await router.send([secondRoute, encode({
        version: 1,
        requestId: secondSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-2",
        afterSequence: 1,
        resumeCursor: encodeEventCursor(agent.id, 1),
      })])
      await router.send([secondRoute, encode(event)])
      const [, secondUnsubscribeFrame] = await router.receive()
      assert.equal(decode(secondUnsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(agent.id, 2))
    await iterator.return()
    await responder
  })
})

test("reconnects a replaced worker from the acknowledged boundary before the first event", async () => {
  await withReplacementRouters(async (first, second, firstRecord, secondRecord) => {
    let recoveries = 0
    const firstResponder = (async () => {
      const [route, subscribeFrame] = await first.receive()
      const subscribe = decode(subscribeFrame)
      await first.send([route, encode({
        version: 1,
        requestId: subscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: firstRecord.id,
        runtimeGeneration: firstRecord.runtime.generation,
        subscriptionId: "subscription-1",
        afterSequence: 1,
        resumeCursor: encodeEventCursor(firstRecord.id, 1),
      })])
      const [, probeFrame] = await first.receive()
      const probe = decode(probeFrame)
      await first.send([route, encode({
        version: 1,
        requestId: probe.requestId,
        command: "subscription.status",
        ok: false,
        agentId: firstRecord.id,
        runtimeGeneration: firstRecord.runtime.generation,
        subscriptionId: "subscription-1",
        error: "Worker was replaced",
      })])
      const [, unsubscribeFrame] = await first.receive()
      assert.equal(decode(unsubscribeFrame).command, "unsubscribe")
    })()
    const secondResponder = (async () => {
      const [route, subscribeFrame] = await second.receive()
      const subscribe = decode(subscribeFrame)
      assert.equal(subscribe.after, encodeEventCursor(secondRecord.id, 1))
      await second.send([route, encode({
        version: 1,
        requestId: subscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: secondRecord.id,
        runtimeGeneration: secondRecord.runtime.generation,
        subscriptionId: "subscription-2",
        afterSequence: 1,
        resumeCursor: encodeEventCursor(secondRecord.id, 1),
      })])
      await second.send([route, encode(messageEvent(secondRecord, "subscription-2", 2))])
      const [, unsubscribeFrame] = await second.receive()
      assert.equal(decode(unsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(firstRecord, {}, async () => {
      recoveries += 1
      return secondRecord
    })[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(firstRecord.id, 2))
    assert.equal(recoveries, 1)
    await iterator.return()
    await Promise.all([firstResponder, secondResponder])
  })
})

test("reconnects a replaced worker after the last delivered cursor", async () => {
  await withReplacementRouters(async (first, second, firstRecord, secondRecord) => {
    const firstResponder = (async () => {
      const [route, subscribeFrame] = await first.receive()
      const subscribe = decode(subscribeFrame)
      await first.send([route, encode({
        version: 1,
        requestId: subscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: firstRecord.id,
        runtimeGeneration: firstRecord.runtime.generation,
        subscriptionId: "subscription-1",
        afterSequence: 0,
      })])
      await first.send([route, encode(messageEvent(firstRecord, "subscription-1", 1))])
      const [, probeFrame] = await first.receive()
      const probe = decode(probeFrame)
      await first.send([route, encode({
        version: 1,
        requestId: probe.requestId,
        command: "subscription.status",
        ok: false,
        agentId: firstRecord.id,
        runtimeGeneration: firstRecord.runtime.generation,
        subscriptionId: "subscription-1",
        error: "Worker was replaced",
      })])
      await first.receive()
    })()
    const secondResponder = (async () => {
      const [route, subscribeFrame] = await second.receive()
      const subscribe = decode(subscribeFrame)
      assert.equal(subscribe.after, encodeEventCursor(secondRecord.id, 1))
      await second.send([route, encode({
        version: 1,
        requestId: subscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: secondRecord.id,
        runtimeGeneration: secondRecord.runtime.generation,
        subscriptionId: "subscription-2",
        afterSequence: 1,
        resumeCursor: encodeEventCursor(secondRecord.id, 1),
      })])
      await second.send([route, encode(messageEvent(secondRecord, "subscription-2", 2))])
      await second.receive()
    })()

    const iterator = receiveEvents(firstRecord, {}, async () => secondRecord)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(firstRecord.id, 1))
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(firstRecord.id, 2))
    await iterator.return()
    await Promise.all([firstResponder, secondResponder])
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
        cursor: encodeEventCursor(agent.id, sequence),
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
        afterSequence: 0,
      })])
      await router.send([firstRoute, encode(event(1))])
      await router.send([firstRoute, encode(event(3))])
      const [, firstUnsubscribeFrame] = await router.receive()
      assert.equal(decode(firstUnsubscribeFrame).command, "unsubscribe")

      const [secondRoute, secondSubscribeFrame] = await router.receive()
      const secondSubscribe = decode(secondSubscribeFrame)
      assert.equal(secondSubscribe.command, "subscribe")
      assert.equal(secondSubscribe.after, encodeEventCursor(agent.id, 1))
      await router.send([secondRoute, encode({
        version: 1,
        requestId: secondSubscribe.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId: "subscription-1",
        afterSequence: 1,
        resumeCursor: encodeEventCursor(agent.id, 1),
      })])
      await router.send([secondRoute, encode(event(2))])
      await router.send([secondRoute, encode(event(3))])
      const [, secondUnsubscribeFrame] = await router.receive()
      assert.equal(decode(secondUnsubscribeFrame).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(agent.id, 1))
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(agent.id, 2))
    assert.equal((await iterator.next()).value.cursor, encodeEventCursor(agent.id, 3))
    await iterator.return()
    await responder
  })
})

test("repairs separate sequence gaps after healthy delivery", async () => {
  await withRouter(async (router, agent) => {
    const event = (subscriptionId, sequence, cursorSequence = sequence) => ({
      version: 1,
      command: "event",
      agentId: agent.id,
      runtimeGeneration: agent.runtime.generation,
      subscriptionId,
      sequence,
      event: {
        type: "message.started",
        cursor: encodeEventCursor(agent.id, cursorSequence),
        eventId: `event-${sequence}`,
        activityId: `activity-${sequence}`,
        timestamp: sequence,
      },
    })
    const acknowledge = async (route, request, subscriptionId, afterSequence) => {
      await router.send([route, encode({
        version: 1,
        requestId: request.requestId,
        command: "subscribe",
        ok: true,
        agentId: agent.id,
        runtimeGeneration: agent.runtime.generation,
        subscriptionId,
        afterSequence,
        ...(afterSequence > 0 ? { resumeCursor: encodeEventCursor(agent.id, afterSequence) } : {}),
      })])
    }
    const responder = (async () => {
      const [firstRoute, firstFrame] = await router.receive()
      await acknowledge(firstRoute, decode(firstFrame), "subscription-1", 0)
      await router.send([firstRoute, encode(event("subscription-1", 1))])
      await router.send([firstRoute, encode(event("subscription-1", 3))])
      assert.equal(decode((await router.receive())[1]).command, "unsubscribe")

      const [secondRoute, secondFrame] = await router.receive()
      await acknowledge(secondRoute, decode(secondFrame), "subscription-2", 1)
      await router.send([secondRoute, encode(event("subscription-2", 2))])
      await router.send([secondRoute, encode(event("subscription-2", 3))])
      await router.send([secondRoute, encode(event("subscription-2", 5))])
      assert.equal(decode((await router.receive())[1]).command, "unsubscribe")

      const [thirdRoute, thirdFrame] = await router.receive()
      await acknowledge(thirdRoute, decode(thirdFrame), "subscription-3", 3)
      await router.send([thirdRoute, encode(event("subscription-3", 4))])
      await router.send([thirdRoute, encode(event("subscription-3", 5))])
      assert.equal(decode((await router.receive())[1]).command, "unsubscribe")
    })()

    const iterator = receiveEvents(agent)[Symbol.asyncIterator]()
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      assert.equal((await iterator.next()).value.cursor, encodeEventCursor(agent.id, sequence))
    }
    await iterator.return()
    await responder
  })
})

test("rejects a frame whose cursor does not match its sequence", async () => {
  await withRouter(async (router, agent) => {
    const responder = (async () => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const [route, subscribeFrame] = await router.receive()
        const subscribe = decode(subscribeFrame)
        await router.send([route, encode({
          version: 1,
          requestId: subscribe.requestId,
          command: "subscribe",
          ok: true,
          agentId: agent.id,
          runtimeGeneration: agent.runtime.generation,
          subscriptionId: `subscription-${attempt}`,
          afterSequence: 0,
        })])
        await router.send([route, encode({
          version: 1,
          command: "event",
          agentId: agent.id,
          runtimeGeneration: agent.runtime.generation,
          subscriptionId: `subscription-${attempt}`,
          sequence: 1,
          event: {
            type: "message.started",
            cursor: encodeEventCursor(agent.id, 2),
            eventId: `event-${attempt}`,
            activityId: `activity-${attempt}`,
            timestamp: attempt,
          },
        })])
        assert.equal(decode((await router.receive())[1]).command, "unsubscribe")
      }
    })()

    await assert.rejects(receiveEvents(agent).next(), AgentUnavailableError)
    await responder
  })
})
