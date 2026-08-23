import assert from "node:assert/strict"
import test from "node:test"

import { version } from "../../dist/index.js"

test("exports the package version", () => {
  assert.equal(version, "0.6.0")
})
