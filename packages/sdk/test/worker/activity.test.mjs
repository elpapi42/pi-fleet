import assert from "node:assert/strict"
import test from "node:test"
import { LiveActivity } from "../../dist/worker/activity.js"

function publish(activity, rawEvent, sequence) {
  const event = activity.normalizePiEvent(rawEvent)
  assert.ok(event)
  activity.publishEvent(sequence, { ...event, cursor: `pf1.test-${sequence}` })
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
  const replay = activity.normalizePiEvent({ type: "message_start", message: { role: "assistant" } })
  const live = activity.normalizePiEvent({ type: "message_end", message: { role: "assistant", content: [] } })
  assert.ok(replay)
  assert.ok(live)
  assert.equal(activity.queueReplay(subscriptionId, { sequence: 1, event: { ...replay, cursor: "pf1.test-1" } }), true)
  assert.equal(activity.publishEvent(2, { ...live, cursor: "pf1.test-2" }), true)
  assert.equal(activity.nextOutbound()?.message.sequence, 1)
  assert.equal(activity.nextOutbound(), undefined)
  assert.equal(activity.finishReplay(subscriptionId), true)
  assert.equal(activity.nextOutbound()?.message.sequence, 2)
})
