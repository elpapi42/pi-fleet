# Changelog

## Unreleased

### Reliability

- Added deterministic fault-injection coverage for receive timeout/cancellation, delivery recovery, runtime crashes, Pi RPC failures, SQLite worker/storage failures, protocol framing, command races, raw session boundaries, and public-error redaction.
- Serialized create, send, and destroy transitions per agent so cross-command races cannot orphan or resurrect an agent generation.
- Made SQLite-worker failures terminal for current and future calls and made send recovery safe when an operation exists but no send record was committed.
- Redacted Pi stderr and unexpected internal exceptions from public errors while retaining stable typed error codes.
- Contained asynchronous coordinator event/store failures by stopping the affected Pi process and rejecting waiters instead of producing unhandled promise rejections.
- Added a nightly reliability workflow and an isolated soak suite covering 500 concurrent ordered sends and 100 name lifecycle cycles.
- Reject invalid UTF-8 in stdin and Pi RPC stdout instead of silently replacing bytes at either protocol boundary.
- Keep idle agents `idle + absent` after pi-fleet-initiated orderly shutdown even when Pi reports a nonzero exit; active work remains `failed/runtime_interrupted`.
- Align explicit stdin input with the runtime's 512 KiB message limit and document credential-environment and receive-timeout behavior before the quick start.
- Install native services without forcing the default persistent state directory into `PIFLEET_STATE_ROOT`, preserving the default split between durable SQLite state and the private runtime socket.
- Validated systemd user lingering, idle reboot restoration, active reboot interruption without replay, single-writer restoration, and session preservation in a disposable privileged systemd container.
- Added a fail-closed production-audit policy that permits only `GHSA-3jxr-9vmj-r5cp` at the exact `brace-expansion@5.0.6` path pinned by managed Pi `0.80.10`; every changed or additional vulnerability still blocks release.

## 0.1.0-beta.9 — 2026-07-20

Core product and Linux supervision validation after beta.8.

### Fixed

- An orderly pi-fleet shutdown now leaves idle agents `idle + absent` even if Pi reports a nonzero exit; active interrupted work still becomes `failed/runtime_interrupted` without replay.
- A clean native-service install no longer forces the default persistent state directory into `PIFLEET_STATE_ROOT`, so the service and ordinary CLI agree on the private runtime socket while SQLite remains in durable state storage.
- Explicit stdin now uses the runtime's default 512 KiB message boundary instead of accepting a larger payload that the runtime later rejects.
- Onboarding now explains persistent credential environments before the first operational command and uses explicit receive timeout units.

### Validated

- Reused one real Pi session through the same pi-fleet entry across a service restart and related follow-up assignment with less re-explanation.
- Proved user lingering, idle PID-1 restart without eager restoration, single-writer session restoration, active restart interruption without replay, explicit recovery, and session preservation in a disposable systemd container.

### Security

- The production audit remains fail-closed except for one deliberate exact exception: managed Pi `0.80.10` currently pins `brace-expansion@5.0.6` affected by local glob-input denial-of-service advisory `GHSA-3jxr-9vmj-r5cp`. The policy verifies the advisory, package versions, and installed path and rejects every additional or changed vulnerability. Upstream tracking is `earendil-works/pi#6882`.

## 0.1.0-beta.8 — 2026-07-20

Publishes the beta.7 manual-testing fixes after its immutable tag failed before npm publication.

### Changed

- The process-tree fixture now waits for both parent and child SIGTERM handlers through an IPC readiness handshake before exposing their PIDs, removing a CI scheduling race while preserving the real escalation assertion.
- Includes the beta.7 `watch` EPIPE and pre-dispatch restoration-failure fixes; beta.7 itself was never published to npm.

## 0.1.0-beta.7 — 2026-07-20

Continued direct CLI edge-case testing. No intentional command-surface change.

### Fixed

- `watch` now treats downstream `EPIPE` as normal client disconnection, exiting successfully without misreporting a closed output pipe as `invalid_arguments`.
- A restoration failure proven to occur before prompt dispatch now returns `pi_start_failed`, marks the send definitively failed, leaves the agent `failed + absent`, and releases process capacity instead of claiming `delivery_uncertain` and leaving `restoring + starting` state.
- Restoration cleanup uncertainty remains fail-closed as `incarnation_cleanup_uncertain` with its process slot retained when pi-fleet cannot prove the spawned process is gone.

### Manual validation

- Exercised active runtime death with held clients, hanging/HTTP-error/malformed providers, 19 MB watch backpressure, stdin limits, Unicode paths, extension UI cancellation, oversized session records, watch pipe closure, and missing-cwd restoration in isolated environments.

## 0.1.0-beta.6 — 2026-07-20

Manual interruption-semantics correction. No intentional command-surface change.

### Fixed

- `receive` now returns the agent's stored failure code when the agent is failed instead of returning an older assistant response as successful completion of interrupted work.
- Added regression coverage for the exact state observed during manual testing: a previous response exists, later work is interrupted, the Pi process is absent, and immediate receive reports `runtime_interrupted`.

## 0.1.0-beta.5 — 2026-07-20

Release-pipeline reliability follow-up; includes the beta.4 receive and argument-validation fixes.

### Fixed

- On Linux, process-group cleanup now treats zombie processes as exited by inspecting procfs instead of relying only on signal probes. This prevents conservative cleanup waits and CI failures when an orphaned descendant is awaiting reaping.
- Pi shutdown now waits for the child-process exit callback and coordinator transition before reporting completion, preventing a status read from briefly retaining `resident` after an idle release.
- Repeated the process-tree and real-Pi process suites five times locally before tagging after beta.4's publish workflow exposed the runner-specific zombie behavior.

## 0.1.0-beta.4 — 2026-07-20

Manual edge-case testing fix. No intentional CLI contract change.

### Fixed

- Prevented `receive --timeout 0` from rejecting an idle waiter before a handler was attached and terminating the runtime with an unhandled `Receive cancelled` rejection.
- Added explicit coordinator work tracking so promptless/repeated idle polling returns `no_response` or the latest response immediately, while managed work still waits for Pi settlement.
- Closed the abort-listener registration race and added regression coverage for timeout, disconnect, repeated receive, and settlement ordering.
- Return durable `invalid_arguments` errors for rejected Pi startup/positional arguments instead of a generic `internal_error`.

### Manual validation

- Direct isolated lifecycle, timeout, repeated receive, raw watch, session mutation, concurrent startup/send, Pi/runtime crash recovery, capacity, and session-preservation scenarios passed against the beta.4 source build.
- Fresh-registry operational validation remains enforced by the tag workflow after publication.

## 0.1.0-beta.3 — 2026-07-20

Reliability fix for fresh global npm installations. No intentional CLI or agent-lifecycle contract change.

### Fixed

- Replaced the invalid assumption that npm recreates CI's byte-identical `node_modules` tree. Schema-3 runtime manifests retain exact hashes for pi-fleet-owned files, validate direct dependency name/version, derive the observed dependency-closure hash at materialization, and prove source-before, staged, and source-after closure equality before activation.
- Made immutable runtime release paths closure-specific, so different legitimate npm dependency layouts do not collide.
- Strengthened package testing to mutate a fresh installed dependency tree, require an operational `list`, remove the npm installation, stop the runtime, and restart through the materialized release.

### Installation scope

- The documented global npm installation layout, where dependencies are package-local, is supported. Arbitrarily hoisted local-prefix, pnpm, and unusual `npx` dependency layouts are not yet supported.
- The tag workflow now performs a fresh registry-install operational `list` smoke after publishing. That smoke is a release gate and has not yet run for beta.3.

## 0.1.0-beta.2 — 2026-07-20

Reliability-focused beta maintenance release. No intentional product-contract changes.

### Reliability

- Added deterministic fault coverage and reproducible randomized lifecycle-race soak testing.
- Fixed timeout/cancellation classification, ambiguous-delivery recovery, no-replay behavior, and coordinator/store failure containment.
- Validated inbound protocol majors, strict and concurrent runtime materialization, and released beta.0/beta.1 CLI-runtime compatibility.
- Added unclean SQLite `quick_check` validation, redacted error handling, fatal UTF-8 checks, process cleanup coverage, and nightly resource-stability checks.

### Validation limits

- Real disk exhaustion, host logout/reboot, macOS launchd/containment, and multi-hour platform resource soak remain unvalidated.

## 0.1.0-beta.1 — 2026-07-20

Release-pipeline validation beta. No product-contract changes from `0.1.0-beta.0`.

### Changed

- Publishes through the tag-driven GitHub Actions workflow using npm trusted publishing and provenance.
- Retains the same Linux x64 validation scope, beta limitations, and user-owned Pi session guarantees as `0.1.0-beta.0`.

## 0.1.0-beta.0 — 2026-07-20

First public beta of pi-fleet.

### Included

- Seven-command JSON-first CLI: `create`, `send`, `receive`, `status`, `list`, `watch`, and `destroy`.
- Resident Pi processes with stable pi-fleet addresses and restore-on-address from native Pi sessions.
- Exact compatible Pi argument passthrough after `--` and pi-fleet-owned `--cwd`.
- Ordered repeated steering input and idle-based latest-assistant response retrieval.
- Raw live Pi session JSONL watching.
- SQLite-backed names, latest responses, operation idempotency, and conservative crash recovery.
- Verified immutable runtime materialization with recursively hashed production dependencies.
- Linux process-group cleanup, bounded capacity/streams, and systemd service foundations.
- Managed `@earendil-works/pi-coding-agent@0.80.10` runtime dependency.

### Beta limitations

- Release validation covers Linux x64 only.
- Actual logout/reboot recovery is not yet validated.
- macOS launchd and descendant containment are not release-validated.
- Service management has no public supported CLI yet.
- Automatic runtime upgrades and binary rollback across schema migrations are not supported.
- `watch` cannot guarantee exactly-once output under arbitrary external session rewrites.

Pi sessions remain user-owned and are never deleted by `pifleet destroy` or npm uninstall.
