import assert from "node:assert/strict"
import test from "node:test"
import { LiveActivity } from "../../dist/worker/activity.js"

function normalize(activity, rawEvent) {
  return activity.normalizePiEvent(rawEvent)
}

function publish(activity, rawEvent, sequence) {
  const events = normalize(activity, rawEvent)
  assert.equal(events.length, 1)
  activity.publishEvent(sequence, { ...events[0], cursor: `pf1.test-${sequence}` })
}

test("delivers queued activity fairly across subscribers", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const firstId = activity.subscribe(Buffer.from("first"), false)
  const secondId = activity.subscribe(Buffer.from("second"), false)

  publish(activity, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} }, 1)
  publish(activity, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false }, 2)

  assert.deepEqual([
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
  ], [firstId, secondId, firstId, secondId])
})

test("bounds requested arguments and final tool output before queueing", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  activity.subscribe(Buffer.from("subscriber"), false)
  publish(activity, {
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "x".repeat(16 * 1024 + 1) },
  }, 1)
  publish(activity, {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: true,
    result: {
      content: [
        { type: "text", text: "x".repeat(64 * 1024 + 1) },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      details: { stderr: "x".repeat(16 * 1024 + 1) },
    },
  }, 2)

  const started = activity.nextOutbound()?.message.event
  const finished = activity.nextOutbound()?.message.event
  assert.deepEqual(started && started.type === "tool.started" && { args: started.args, argsTruncated: started.argsTruncated }, {
    args: null,
    argsTruncated: true,
  })
  assert.ok(finished && finished.type === "tool.finished")
  if (!finished || finished.type !== "tool.finished") return
  assert.ok(Buffer.byteLength(JSON.stringify(finished.output.content[0].text)) <= 64 * 1024)
  assert.deepEqual(finished.output.content[1], { type: "image", mimeType: "image/png", byteLength: 5, omitted: true })
  assert.equal(finished.output.details, undefined)
  assert.equal(finished.output.detailsTruncated, true)
  assert.equal(finished.output.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(finished)) <= 128 * 1024)
})

test("keeps a maximum-shaped normalized event below the complete event limit", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  activity.subscribe(Buffer.from("subscriber"), false)
  publish(activity, {
    type: "tool_execution_end",
    toolCallId: "i".repeat(256),
    toolName: "t".repeat(256),
    isError: false,
    result: {
      content: [
        { type: "text", text: "x".repeat(64 * 1024) },
        ...Array.from({ length: 63 }, () => ({ type: "image", mimeType: "m".repeat(256), data: "aGVsbG8=" })),
      ],
      details: "d".repeat(16 * 1024 - 2),
    },
  }, 1)

  const event = activity.nextOutbound()?.message.event
  assert.equal(event?.type, "tool.finished")
  assert.ok(event)
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 128 * 1024)
})

test("omits malformed tool result data", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  activity.subscribe(Buffer.from("subscriber"), false)
  publish(activity, {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: true,
    result: { content: [{ type: "image", data: "AQID" }], details: () => "not JSON" },
  }, 1)

  const event = activity.nextOutbound()?.message.event
  assert.equal(event?.type, "tool.finished")
  assert.deepEqual(event?.output, { content: [], detailsTruncated: true, truncated: true })
})

test("projects only visible assistant text as a message", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  assert.deepEqual(normalize(activity, { type: "message_start", message: { role: "assistant" } }), [])
  assert.deepEqual(normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  }).map(({ type }) => type), ["thinking.started"])
  assert.deepEqual(normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "I will check." },
  }).map(({ type }) => type), ["thinking.finished"])
  assert.deepEqual(normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 1 },
  }), [])
  assert.deepEqual(normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "   " },
  }), [])
  const started = normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Visible" },
  })
  assert.deepEqual(started.map(({ type }) => type), ["message.started"])
  const finished = normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Visible text" }] },
  })
  assert.deepEqual(finished.map(({ type }) => type), ["message.finished"])
  assert.equal(finished[0].type === "message.finished" && finished[0].text, "Visible text")
  assert.equal(finished[0].activityId, started[0].activityId)
})

test("starts a visible message from a populated text start", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  assert.deepEqual(normalize(activity, { type: "message_start", message: { role: "assistant" } }), [])
  const started = normalize(activity, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "Visible at start" }] },
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  })
  assert.deepEqual(started.map(({ type }) => type), ["message.started"])
  const finished = normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Visible at start" }] },
  })
  assert.equal(finished[0].activityId, started[0].activityId)
})

test("suppresses thinking-only and tool-only assistant envelopes", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  assert.deepEqual(normalize(activity, { type: "message_start", message: { role: "assistant" } }), [])
  assert.deepEqual(normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "toolCall", id: "call-1" }] },
  }), [])
  assert.deepEqual(normalize(activity, { type: "message_start", message: { role: "assistant" } }), [])
  assert.deepEqual(normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: " \n\t" }] },
  }), [])
})

test("emits a matching fallback message pair from a final-only response", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const events = normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
  })
  assert.deepEqual(events.map(({ type }) => type), ["message.started", "message.finished"])
  assert.equal(events[0].activityId, events[1].activityId)
  assert.equal(events[1].type === "message.finished" && events[1].text, "Final answer")
})

test("aggregates multiple visible text blocks into one message", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  assert.deepEqual(normalize(activity, { type: "message_start", message: { role: "assistant" } }), [])
  const first = normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First" },
  })
  assert.deepEqual(first.map(({ type }) => type), ["message.started"])
  assert.deepEqual(normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Second" },
  }), [])
  const finished = normalize(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "First" }, { type: "text", text: "Second" }] },
  })
  assert.equal(finished[0].type === "message.finished" && finished[0].text, "FirstSecond")
  assert.equal(finished[0].activityId, first[0].activityId)
})

test("resets private assistant-envelope correlation between Pi incarnations", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  normalize(activity, { type: "message_start", message: { role: "assistant" } })
  const oldThinking = normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  })[0]
  activity.resetPiActivity()
  normalize(activity, { type: "message_start", message: { role: "assistant" } })
  const newThinking = normalize(activity, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "New Pi" },
  })[0]
  assert.equal(oldThinking.type, "thinking.started")
  assert.equal(newThinking.type, "thinking.finished")
  assert.notEqual(newThinking.activityId, oldThinking.activityId)
})

test("removes a subscriber whose bounded activity queue overflows", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const route = Buffer.from("slow")
  const subscriptionId = activity.subscribe(route, false)

  for (let index = 0; index < 129; index += 1) {
    publish(activity, { type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "bash", args: {} }, index + 1)
  }

  assert.equal(activity.hasSubscription(route, subscriptionId), false)
})

test("holds committed live activity until replay drains", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const subscriptionId = activity.subscribe(Buffer.from("subscriber"), true)
  const replay = normalize(activity, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} })[0]
  const live = normalize(activity, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false })[0]
  assert.ok(replay)
  assert.ok(live)
  assert.equal(activity.queueReplay(subscriptionId, { sequence: 1, event: { ...replay, cursor: "pf1.test-1" } }), true)
  assert.equal(activity.publishEvent(2, { ...live, cursor: "pf1.test-2" }), true)
  assert.equal(activity.nextOutbound()?.message.sequence, 1)
  assert.equal(activity.nextOutbound(), undefined)
  assert.equal(activity.finishReplay(subscriptionId), true)
  assert.equal(activity.nextOutbound()?.message.sequence, 2)
})
