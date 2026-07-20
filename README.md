# Pi Fleet

Pi Fleet is a local runtime and machine-first CLI for named Pi agents.

```text
create · send · receive · status · list · watch · destroy
```

Pi sessions remain under user control. Native Pi arguments pass through after `--`; Fleet is intended to manage named process lifecycle, restoration, latest-response retrieval, and raw session tailing.

## Development status

Milestones 1–7 are complete on Linux x64 with Pi 0.80.10. The CLI/runtime protocol, seven commands, native Pi session restoration, resident process reuse, raw session watching, and SQLite-backed recovery are implemented. Milestone 8 adds a pinned managed Pi target, verified materialized runtime releases, Linux process-group cleanup, and systemd/launchd service-definition foundations.

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

Linux x64 package and user-service behavior is locally validated. macOS arm64 launchd behavior, logout/reboot recovery, and process-group containment remain release gates and are not claimed as complete.

Pi sessions remain user-owned: service removal and `pifleet destroy` never delete them. See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for completed evidence and remaining platform gates.
