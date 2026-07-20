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

- Replaced the invalid assumption that npm recreates CI's byte-identical `node_modules` tree. Schema-3 runtime manifests retain exact hashes for Fleet-owned files, validate direct dependency name/version, derive the observed dependency-closure hash at materialization, and prove source-before, staged, and source-after closure equality before activation.
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

First public beta of Pi Fleet.

### Included

- Seven-command JSON-first CLI: `create`, `send`, `receive`, `status`, `list`, `watch`, and `destroy`.
- Named resident Pi processes with restore-on-address from native Pi sessions.
- Exact compatible Pi argument passthrough after `--` and Fleet-owned `--cwd`.
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
