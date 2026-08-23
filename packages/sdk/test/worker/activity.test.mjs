import assert from "node:assert/strict"
import test from "node:test"
import { LiveActivity } from "../../dist/worker/activity.js"

test("delivers queued activity fairly across subscribers", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const firstId = activity.subscribe(Buffer.from("first"))
  const secondId = activity.subscribe(Buffer.from("second"))

  activity.publishPiEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} })
  activity.publishPiEvent({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false })

  assert.deepEqual([
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
    activity.nextOutbound()?.subscriptionId,
  ], [firstId, secondId, firstId, secondId])
})

test("removes a subscriber whose bounded activity queue overflows", () => {
  const activity = new LiveActivity("agent-1", "runtime-1")
  const route = Buffer.from("slow")
  const subscriptionId = activity.subscribe(route)

  for (let index = 0; index < 129; index += 1) {
    activity.publishPiEvent({
      type: "tool_execution_start",
      toolCallId: `tool-${index}`,
      toolName: "bash",
      args: {},
    })
  }

  assert.equal(activity.hasSubscription(route, subscriptionId), false)
})
