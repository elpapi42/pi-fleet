# Changelog

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
