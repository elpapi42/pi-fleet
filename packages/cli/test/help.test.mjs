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
  assert.match(result.stdout, /Usage: pif \[options\] \[command\]/)
  assert.match(result.stdout, /create \[options\] <name>/)
  assert.match(result.stdout, /send \[options\] <name> <message>/)
  assert.match(result.stdout, /receive <name>/)
})

test("shows the CLI package version", () => {
  const result = spawnSync(process.execPath, ["../dist/main.js", "--version"], {
    cwd: import.meta.dirname,
    encoding: "utf8"
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, "0.7.1\n")
})
