# Pi Fleet

Pi Fleet is a local runtime and machine-first CLI for named, long-lived Pi agents.

```text
create · send · receive · status · list · watch · destroy
```

Fleet keeps a Pi process resident when possible, restores it from the same native Pi session when absent, accepts repeated steering input, and returns the latest assistant message after Pi becomes idle. Pi sessions remain under your control: Fleet references them but never copies or deletes them.

> **Beta:** `0.1.0-beta.0` is release-validated on Linux x64 with Pi `0.80.10`. macOS, actual logout/reboot recovery, automatic upgrades, and public service-management UX are not yet release-validated.

## Install

Requirements:

- Linux x64
- Node.js `^22.19.0 || ^24.0.0`
- normal Pi provider credentials and configuration

Install the beta globally:

```bash
npm install --global @elpapi42/pi-fleet@beta
pifleet --version
pifleet list
```

`npx @elpapi42/pi-fleet@beta` is suitable for evaluation, but a global installation is recommended for continued use. Fleet materializes a verified runtime independently of the npm installation/cache, and evaluation can leave that runtime and Fleet state behind intentionally.

Pi Fleet includes the tested Pi coding-agent package. It uses your normal Pi configuration, provider credentials, extensions, skills, and project resources. **Do not put API keys or other secrets in CLI arguments:** Fleet persists accepted Pi arguments so it can restore the agent. Use Pi's credential configuration or provider environment variables instead.

## Quick start

Create a promptless named agent in the current project:

```bash
pifleet create reviewer --cwd "$PWD"
```

Send work and retrieve the latest assistant message after Pi becomes idle:

```bash
pifleet send reviewer "Review the authentication changes"
pifleet receive reviewer --human
```

Inspect and remove Fleet management:

```bash
pifleet status reviewer
pifleet list
pifleet destroy reviewer
```

`destroy` stops Fleet's managed process and removes the Fleet name. It **never deletes the Pi session**.

## Commands

```text
pifleet create NAME [INITIAL_INSTRUCTIONS] [--cwd PATH] [--human] [-- PI_OPTIONS...]
pifleet send NAME MESSAGE [--human]
pifleet receive NAME [--timeout DURATION] [--human]
pifleet status NAME [--human]
pifleet list [--human]
pifleet watch NAME
pifleet destroy NAME [--human]
```

Finite commands emit JSON by default. Add `--human` for concise human output. `watch` has no human mode: stdout is only raw, complete records appended to the selected Pi session JSONL.

Messages can be read explicitly from stdin with `-`:

```bash
git diff | pifleet send reviewer -
pifleet create researcher - < instructions.md
```

### Native Pi arguments

Fleet owns only its small command surface. `--cwd` belongs before the first literal `--`; native Pi options belong after it and retain their token order:

```bash
pifleet create reviewer \
  --cwd /workspace/project \
  -- \
  --session /absolute/path/to/session.jsonl \
  --model anthropic/claude-sonnet-4 \
  --thinking high
```

Supported native session selection includes:

```bash
pifleet create existing -- --session /path/to/session.jsonl
pifleet create exact-id -- --session-id SESSION_ID
pifleet create forked -- --fork /path/to/source.jsonl
pifleet create latest -- --continue
```

Pi interprets these options directly. An existing or missing `--session` path follows native Pi behavior, and an exact `--session-id` remains exact. Fleet records the concrete selected session only so later process restoration reopens the same conversation. Headless `--resume` is not supported because it requires interactive selection before RPC mode.

Positional Pi prompts and `@file` inputs after `--` are rejected; use Fleet's optional create instructions or `send` so input remains ordered.

## Communication semantics

`send` uses Pi's normal context-sensitive prompt operation with steering behavior:

- while Pi is active, input is queued as steering;
- while Pi is idle, input begins normal work;
- repeated sends are accepted in order;
- acknowledgement means Pi accepted/queued the input, not that it completed or produced a distinct response.

`receive` deliberately has no per-send response correlation:

- while Pi is busy or restoring, it waits for Pi to become idle;
- once idle, it returns Pi's latest assistant message;
- when already idle, it returns immediately;
- with no assistant message, it returns `no_response`;
- `--timeout 0` performs an immediate poll;
- timing out does not cancel or change Pi.

## Sessions and `watch`

Pi and you own session files, IDs, locations, creation, migration, and deletion. Fleet never copies, relocates, or deletes them.

```bash
pifleet watch reviewer > live-session.jsonl
```

`watch` is live-only. For an existing file it begins at the current EOF; for a not-yet-materialized file it waits and begins at byte zero. It does not emit Fleet wrappers, history, or transient RPC events. Concurrent external rewrites can invalidate tailing; detectable replacement, truncation, lag, or runtime loss is reported on stderr.

## Runtime and local data

The short-lived CLI connects to one private per-user runtime. On first operational use, Fleet verifies and materializes an immutable runtime release, then starts it in the background. A registered native service is preferred when present; service management is experimental and is not part of the seven-command beta interface.

Linux defaults:

```text
Fleet state:       ~/.local/state/pi-fleet/
Materialized code: ~/.local/share/pi-fleet/releases/
Runtime socket:    $XDG_RUNTIME_DIR/pifleet-$UID/control.sock
                   (or the system temporary directory when XDG_RUNTIME_DIR is absent)
Pi sessions:       Pi's normal ~/.pi storage or the exact path you selected
```

`PIFLEET_STATE_ROOT` and `PIFLEET_APPLICATION_ROOT` can override Fleet-owned locations. A CLI invocation whose state root differs from an installed service fails immediately with repair guidance instead of connecting to the wrong database.

## Uninstall and recovery

Before uninstalling, destroy agents you no longer want Fleet to manage:

```bash
pifleet list --human
pifleet destroy AGENT_NAME
npm uninstall --global @elpapi42/pi-fleet
```

Removing the npm package does not delete Pi sessions, Fleet's SQLite state, materialized runtime releases, or an already-running runtime/service. This protects durable agents from package-manager changes. Reinstalling the same or a compatible version reconnects to the preserved state.

There is intentionally no automatic self-update, telemetry, remote transport, or npm `postinstall` service registration. Database migrations are forward-only; installing an older binary after a newer schema migration is not a supported rollback strategy.

For support, include:

```bash
node --version
pifleet --version
pifleet list
pifleet status AGENT_NAME
```

Do not include API keys, message contents, session contents, or private paths unnecessarily. Report reproducible issues at <https://github.com/elpapi42/pi-fleet/issues>.

## Beta limitations

- Release validation currently covers Linux x64 only.
- Actual logout and host reboot recovery remain unvalidated.
- launchd and macOS descendant containment remain unvalidated.
- Native service install/repair/uninstall exists internally but has no supported public UX yet.
- Runtime upgrades are not automatic; active runtimes are not silently replaced.
- Session tails cannot promise exactly-once behavior under arbitrary external mutation.
- A promptless missing session path may remain physically unmaterialized until Pi writes conversation content, following native Pi behavior.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:faults
npm run build
npm run test:package
npm run test:platform
npm run test:soak
```

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for architecture and release gates, and [`TESTING_PLAN.md`](./TESTING_PLAN.md) for failure injection, crash recovery, concurrency, privacy, and soak testing. Deterministic fault tests run in the full suite; heavier reliability checks run nightly.

## License

MIT © elpapi42
