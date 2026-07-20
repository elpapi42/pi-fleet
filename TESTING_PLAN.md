# Pi Fleet Edge-Case Reliability Test Plan

## Objective

Prove that Pi Fleet remains safe and predictable under timeouts, crashes, malformed input, storage failures, concurrency, process loss, and recovery—not merely that the happy path works.

## Implementation status

The first reliability-hardening pass is implemented after `v0.1.0-beta.1`:

- A dedicated `test:faults` suite covers receive timeout/disconnect/destroy behavior, durable delivery replay boundaries, compiled-runtime `SIGKILL` recovery, cross-command serialization, Pi RPC framing/exit/timeout failures, SQLite worker death/malformed responses/corruption/locking, fail-closed dispatch, protocol malformed/oversized/unterminated input, raw-watch record boundaries, and public error redaction.
- Reusable scripted-Pi, fault-barrier, isolated-environment, and side-effect-ledger fixtures are available under `test/fixtures` and `test/helpers`.
- Production fixes now distinguish receive timeout from connection cancellation, reject all current and future store calls after SQLite-worker failure, clean pending Pi requests after write failures, redact unexpected public errors and Pi stderr, serialize create/send/destroy per agent, safely resume send operations when no send row was committed, return stable receive errors when destroy/interruption wins, and contain asynchronous coordinator event/store failures by stopping Pi and rejecting waiters.
- The tag publishing workflow runs all deterministic tests through `npm test`; a separate nightly Linux workflow runs faults, process, compatibility, a 500-send/100-lifecycle soak, and the store benchmark.

The remaining Priority 1/2 matrix is intentionally tracked below. Full disk-exhaustion injection, randomized long-duration soak, actual logout/reboot, macOS launchd/containment, and cross-version released-package matrices require dedicated disposable environments and remain release-evidence gates rather than claims inferred from unit tests.

## Required invariants

1. At most one Fleet-owned Pi process group exists per agent.
2. Ambiguously delivered input is never replayed automatically.
3. Input proven unwritten may be dispatched after recovery.
4. Client timeout, cancellation, or disconnection never cancels or corrupts Pi work.
5. Runtime, Pi, and SQLite failures produce honest failed, uncertain, or recoverable states.
6. No durable operation remains permanently stuck.
7. Fleet never deletes or silently substitutes a user-owned Pi session.
8. Slow receivers and watchers cannot block Pi or cause unbounded memory growth.
9. Public errors never expose prompts, credentials, session content, Pi stderr, database rows, or stack traces.
10. Every finite command preserves its JSON/stdout/stderr/exit-code contract; `watch` emits only raw Pi session bytes.

## Test infrastructure

Add deterministic, isolated fixtures before broad fault tests:

```text
test/faults/
  receive-failures.test.ts
  delivery-crash-matrix.test.ts
  runtime-crashes.test.ts
  pi-rpc-failures.test.ts
  sqlite-failures.test.ts
  command-races.test.ts
  watch-failures.test.ts
  error-redaction.test.ts

test/fixtures/
  scripted-pi.mjs
  crashable-runtime.mjs
  crashable-sqlite-worker.mjs
  side-effect-counter.mjs
  stderr-canary-pi.mjs

test/helpers/
  isolated-environment.ts
  runtime-harness.ts
  cli-harness.ts
  fault-barrier.ts
  process-census.ts
  store-inspector.ts
  session-inspector.ts
```

The scripted Pi fixture must support barriers and faults at startup, prompt read/write/acknowledgement, state inspection, settlement, stdout framing, and shutdown. A side-effect ledger records every handled instruction so crash tests can prove delivery count is never greater than one.

Every process test uses temporary `HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `PIFLEET_STATE_ROOT`, and `PIFLEET_APPLICATION_ROOT`. Tests must never touch the developer's normal Fleet service, database, sessions, or Pi configuration.

Use semantic barriers rather than arbitrary sleeps at these boundaries:

```text
operation persisted
agent inserted
incarnation starting persisted
Pi spawned
Pi ready
send pending persisted
send dispatching persisted
prompt bytes written
Pi acknowledgement received
send acknowledged persisted
result persisted
agent deletion persisted
```

## Priority 0 — release-blocking reliability

### Receive timeout and cancellation

Cover idle response, idle `no_response`, `--timeout 0`, finite timeout, settlement immediately before/after timeout, response retrieval after caller timeout, multiple receivers, client disconnect, Ctrl-C, later sends extending the wait, runtime death, destroy while waiting, and waiter cleanup.

A timeout affects only the caller: it never cancels Pi, consumes a response, or mutates agent state. Runtime loss is `runtime_unavailable` with exit 1, not timeout 124.

### Create/send delivery crash matrix

Inject failure after every durable/send boundary. Pending and proven-unwritten input may dispatch. Any possible write or acknowledgement ambiguity becomes uncertain and is never replayed. A committed acknowledgement with a lost CLI response must replay the original operation result. Conflicting payload retries return `operation_conflict`.

Run the same matrix for initial `create` instructions and ordinary `send`. After each crash/restart, inspect operations, sends, agents, incarnations, process groups, side-effect count, and session existence.

### Pi RPC failures

Cover missing/denied executable, pre-readiness exit, readiness timeout, malformed/invalid/split/coalesced/partial/oversized JSONL frames, CRLF and empty records, unknown/duplicate/late responses, stderr flood, stdin backpressure/EPIPE, process exit around acknowledgement, duplicate settlement, blocking extension UI, and stubborn descendants.

All pending promises terminate, stderr remains bounded, no unhandled rejection occurs, cleanup is proven or marked uncertain, and no replacement starts while an old writer may remain.

### Runtime crashes and unexpected errors

Kill the compiled runtime during create, send, destroy, restoration, settlement handling, latest-response persistence, receive, watch, migration, and shutdown. Inject thrown errors/rejections from request dispatch, Pi events, coordinator/store/session-tail callbacks, stream writers, timers, and shutdown handlers.

After restart, idle agents remain absent, active work becomes interrupted, pending operations resume safely, ambiguous input remains uncertain, old process groups are absent or cleanup-uncertain, and connected clients fail visibly rather than hanging.

### SQLite and storage failures

Cover worker startup/exit/malformed response, future calls after worker death, read-only/locked/full/corrupt database, WAL and unclean recovery, failed integrity checks, migration checksum/future schema/transaction rollback, commit ambiguity, directory deletion, and permission changes.

Storage failure is fail-closed: no uncommitted input is dispatched, no unpersisted success is returned, Pi streams continue draining where possible, and corrupt/future databases are never silently replaced.

### Privacy and redaction

Plant canaries in messages, Pi argv, environment values, session/tool content, Pi stderr, database rows, and thrown stacks. Force errors through every boundary and assert canaries are absent from CLI output, public socket errors, logs, systemd journal captures, test output, manifests, and package artifacts. Public unexpected failures use a stable redacted `internal_error`.

## Priority 1 — concurrency, filesystem, and protocol

### Cross-command races

Exercise create/create, create/destroy, send/send, send/receive, send/destroy, receive/destroy, watch/destroy, restore/destroy, settlement/destroy, and runtime shutdown/send. Include identical messages and many concurrent sends.

Prove strict send ordinals, one restoration, monotonic destruction, terminal receiver/watcher behavior, safe name reuse, and generation-safe stale operation IDs.

### Process ownership

Use process trees with normal, SIGTERM-ignoring, and recursively forking children. Cover leader-first exit, TERM/KILL escalation, stale PID reuse, missing cleanup evidence, and destroy races. Names/capacity are released only after complete group absence; unrelated reused PIDs are never killed.

### Raw session watch

Compare bytes for thinking/text/tool records, large signatures, split multibyte UTF-8, multiple records per append, partial final records, exact/oversized limits, invalid external lines, disappearance, truncation, replacement, permissions, restoration, buffered destroy, slow consumers, watcher limits, EPIPE, and runtime loss.

One stalled watcher never blocks Pi or healthy watchers. Queue bytes remain bounded. Unexpected EOF is an error. Fleet emits no wrapper records.

### Socket/protocol resilience

Cover pre-readiness clients, concurrent first startup, stale/incompatible sockets, file/symlink substitution, malformed/no-LF/oversized/multiple requests, unknown method, wrong protocol, mismatched IDs, aborts, EPIPE, shutdown with held streams, deadlines, permissions, and bounded memory.

## Priority 2 — operations, upgrades, and soak

### Native sessions

Test every selector under missing paths, permissions, external mutation, pre-materialization process loss, fork observation crashes, changing `--continue` latest selection, and disappearing session directories. Every destroy/uninstall/recovery case preserves source and resulting Pi sessions.

### Package and service recovery

For every release candidate: pack, install into an unrelated prefix, remove source/npm install/cache, continue through materialized runtime, test compatible/incompatible CLI-runtime versions, schema skew, corrupt artifacts/dependencies, interrupted/concurrent materialization, read-only application root, uninstall/reinstall, missing Node executable, and state-root mismatch.

Linux systemd testing covers Pi-only death, runtime cgroup death while idle/working, one restoration on later send, interruption classification, held-client failure, repair, custom-root preservation, and uninstall without state/session deletion. Actual logout/reboot and macOS run only on disposable platform environments.

### Soak and leak tests

Exercise thousands of fake-Pi sends, repeated create/destroy and timeout/cancel cycles, resident capacity, maximum watchers, runtime restart loops, Pi crash/restoration, retries, and prolonged idle. Record reproducible seeds and monitor RSS, heap, descriptors, sockets, workers, process groups, waiter/queue counts, SQLite/WAL growth, and event-loop delay. Resources must stabilize after cleanup rather than grow per cycle.

## CI cadence

### Every pull request

Run typecheck, lint, formatting, unit, integration, deterministic fault injection, protocol, fake-Pi lifecycle, store contract, build, and release metadata checks.

### Nightly Linux

Run repeated crash/race matrices with recorded seeds, SQLite-worker/storage faults, process-group and systemd recovery, slow-watch tests, real Pi compatibility, and soak/resource-leak checks.

### Release tag

Require all PR/nightly gates plus managed-Pi compatibility, actual npm tarball installation, source/cache removal, systemd smoke, corruption checks, migration/version-skew tests, exact tag/version match, and provenance verification before publishing.

## Completion criteria

The reliability program is complete enough for a stronger beta claim when every Priority 0 boundary has deterministic coverage; no ambiguous send is replayed; no failure produces two writers; timeout/cancellation leaks no resources; SQLite is demonstrably fail-closed; no durable operation remains stuck; process-group absence is proven before release; watch remains bounded; privacy canaries never leak; sessions survive all destructive/recovery operations; and source-, package-, registry-, and materialized-runtime executions satisfy the same black-box CLI contract.

## Implementation order

1. Scripted Pi, semantic barriers, side-effect ledger, and isolated harness.
2. Receive timeout/cancellation matrix.
3. Create/send delivery crash matrix.
4. Runtime/Pi crash and parser/process failures.
5. SQLite-worker and fail-closed storage failures.
6. Concurrency and process cleanup.
7. Watch, filesystem, protocol, and redaction.
8. Package/service/version-skew recovery.
9. Nightly soak and platform-specific environments.
