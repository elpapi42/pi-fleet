# Pi Fleet

Pi Fleet is a local runtime and machine-first CLI for named Pi agents.

```text
create · send · receive · status · list · watch · destroy
```

Pi sessions remain under user control. Native Pi arguments pass through after `--`; Fleet is intended to manage named process lifecycle, restoration, latest-response retrieval, and raw session tailing.

## Development status

All eight implementation milestones are complete for the locally testable Linux x64 scope with Pi 0.80.10. The CLI/runtime protocol, seven commands, native Pi session restoration, ordered repeated sends, resident process reuse, idle-based receive, bounded raw session watching, SQLite-backed crash recovery, pinned managed Pi target, verified materialized releases, whole-process-group cleanup, and systemd service foundations are implemented.

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:package
npm run test:platform
```

Linux x64 package and user-service behavior is locally validated. Materialized releases recursively verify every copied production dependency package, and the internal installer supports idempotent `install`, `repair`, and `uninstall` operations. A safe systemd crash test proved the service cgroup removes the resident Pi child, restart leaves the agent `idle + absent`, and the next `send` alone restores one Pi process on the same native session.

Runtime admission is bounded by configurable production defaults: 32 resident/starting processes, 128 watchers, 512 KiB messages, 1 MiB private protocol frames, and 8 MiB Pi/session records. Environment variables with the `PIFLEET_MAX_*` prefix provide positive-integer deployment overrides.

Pi sessions remain user-owned: service removal and `pifleet destroy` never delete them. Ambiguous prompt delivery is never replayed, active work interrupted by runtime shutdown becomes failed rather than idle, and a name is not released until the managed process group is proven gone. Linux logout/reboot recovery and macOS arm64 launchd/process-group behavior remain release gates and are not claimed as complete; the package is private and has not been published. See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for completed evidence and remaining platform gates.
