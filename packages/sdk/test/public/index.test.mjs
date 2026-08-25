import assert from "node:assert/strict"
import test from "node:test"

import { AgentRecoveryQueueFullError, AgentSendUncertainError, version } from "../../dist/index.js"

test("exports the package version and recovery send errors", () => {
  assert.equal(version, "0.12.0")
  assert.equal(new AgentRecoveryQueueFullError("researcher").name, "AgentRecoveryQueueFullError")
  assert.equal(new AgentSendUncertainError("researcher").name, "AgentSendUncertainError")
})
