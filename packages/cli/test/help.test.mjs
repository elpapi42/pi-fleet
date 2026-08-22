import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("shows help from the built executable", () => {
  const result = spawnSync(process.execPath, ["../dist/main.js", "--help"], {
    cwd: import.meta.dirname,
    encoding: "utf8"
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:/)
  assert.match(result.stdout, /pif --help/)
})
