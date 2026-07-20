# Pi Fleet

**Keep a Pi session reachable between tasks.**

Pi Fleet is a local CLI that gives a native Pi session a stable handle. Start it once, send work from a terminal or script, retrieve the latest result when it settles, and follow up later from the same session. Fleet keeps the Pi process resident when possible and restores it from the selected session when it is absent.

Pi remains Pi: its sessions, models, tools, extensions, skills, and project resources stay under your control. Fleet adds local process lifecycle and a small machine-readable control surface; it does not copy or delete your sessions, invent a workflow, or claim an uninterrupted mind.

```text
create · send · receive · status · list · watch · destroy
```

## Why Pi Fleet?

A normal Pi invocation is excellent for an interactive task. Pi Fleet is for the gap between tasks: you want to return to the same work without reopening a terminal, reselecting a session, or rebuilding the control glue in every script.

```text
Without Fleet                         With Fleet
──────────────────────────────────    ─────────────────────────────────────
start Pi for one task                 create reviewer once
keep the terminal/process around      send reviewer work whenever needed
manually reopen a session later       receive when it settles; follow up later
build your own process plumbing       inspect, tail, or destroy with one CLI
```

The stable handle is a local control name, not a new persona or a second source of truth. The native Pi session remains the conversation record.

## Quick start

### 1. Install

Pi Fleet currently supports Linux x64 with Node.js `^22.19.0 || ^24.0.0` and normal Pi provider credentials/configuration.

```bash
npm install --global @elpapi42/pi-fleet@beta
pifleet --version
```

Configure provider credentials before the first operational Fleet command. `list`, `create`, and other operations start or reuse a persistent runtime; a variable added only to a later invocation, such as `ANTHROPIC_API_KEY=… pifleet create …`, does not change that runtime's environment. Use normal Pi credential configuration or the persistent runtime/service environment.

### 2. Start a reusable handle

```bash
pifleet create reviewer --cwd "$PWD"
```

### 3. Send work, then pick up the result

```bash
pifleet send reviewer "Review the authentication changes"
pifleet receive reviewer --timeout 10m --human
```

### 4. Continue without starting over

```bash
pifleet send reviewer "Turn the important findings into an acceptance checklist"
pifleet receive reviewer --timeout 10m --human
```

`receive` returns Pi's latest assistant message once the session is idle. It is intentionally not a one-send/one-response protocol: several sends can steer the same settled result.

For automation, finite commands emit one compact JSON object by default. Use `--human` only when printing a response directly for a person.

## What Fleet handles—and what it does not

| Fleet handles                                                                                                                                                    | Pi and you control                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable local handles, process residency and restoration, private local control, ordered input delivery, waiting for settlement, raw session tailing, and cleanup | Models, prompts, tools, extensions, skills, project trust, session creation and contents, roles, workflow, approval, scheduling, and autonomy |

This boundary is deliberate. Fleet makes Pi available and controllable; it does not turn Pi into a managed-team product or decide what work it should do.

## Use your native Pi session

Pass compatible Pi selectors after the first literal `--`. Fleet records the concrete session Pi selected solely so a later restoration can reopen it; it never copies, relocates, or deletes session data.

```bash
# Existing session file
pifleet create reviewer --cwd /workspace/project -- --session /absolute/session.jsonl

# Exact Pi session ID
pifleet create reviewer -- --session-id SESSION_ID

# Native first-launch selection
pifleet create reviewer -- --fork /absolute/source.jsonl
pifleet create reviewer -- --continue
```

`--cwd` is a Fleet option and belongs before `--`; all native Pi options belong after it and preserve their token order:

```bash
pifleet create reviewer \
  --cwd /workspace/project \
  -- \
  --session /absolute/session.jsonl \
  --model anthropic/claude-sonnet-4 \
  --thinking high
```

Headless `--resume` is not supported because it requires interactive selection before RPC mode. Positional Pi prompts and `@file` inputs after `--` are rejected; use optional create instructions or `send` so Fleet can preserve ordered input.

## Observe the real session

`watch` emits a live, byte-faithful tail of complete records from the selected Pi session JSONL. It adds no Fleet wrappers, history, or transient RPC events, and it never wakes or steers Pi.

```bash
pifleet watch reviewer > live-session.jsonl
```

For an existing file, watch starts at the current EOF. For a session that has not materialized yet, it waits and begins at byte zero once the file appears. Detectable replacement, truncation, lag, path changes, or runtime loss fail visibly on stderr instead of being guessed or replayed.

## Command reference

```text
pifleet create NAME [INITIAL_INSTRUCTIONS] [--cwd PATH] [--human] [-- PI_OPTIONS...]
pifleet send NAME MESSAGE [--human]
pifleet receive NAME [--timeout DURATION] [--human]
pifleet status NAME [--human]
pifleet list [--human]
pifleet watch NAME
pifleet destroy NAME [--human]
```

Names are 1–63 lowercase letters, digits, or interior hyphens. `status` and `list` are passive: they do not restore a Pi process. An idle handle may be `resident` or `absent`; the next `send` restores an absent session when safe.

### Send and receive

`send` uses Pi's normal context-sensitive prompt operation:

- while Pi is active, it queues steering for Pi's next decision point;
- while idle, it starts ordinary work;
- repeated sends are accepted in order;
- acknowledgement means Pi accepted or queued input, not that work completed.

`receive` waits for idle and returns the latest assistant text. `--timeout 0` polls immediately; explicit durations such as `30s`, `5m`, or `1h` are recommended because a unitless value is milliseconds. Timeout exits `124` and never cancels work. A canceled `receive` affects only that client.

Pass large or shell-sensitive content through explicit stdin. Fleet never consumes piped stdin implicitly. Input is valid UTF-8, nonempty, and limited to 512 KiB by default.

```bash
git diff | pifleet send reviewer -
pifleet create researcher - --cwd "$PWD" < instructions.md
```

### Inspect, recover, and destroy

```bash
pifleet status reviewer
pifleet list
pifleet destroy reviewer
```

Inspect a `failed` state before acting. `runtime_interrupted` means active work stopped without silent replay. `delivery_uncertain` means Pi may have received the input, so do not blindly resend work that could have caused side effects. `incarnation_cleanup_uncertain` means Fleet cannot prove an old process writer is gone. A new explicit send is new work, not proof an uncertain earlier instruction did nothing.

`destroy` stops Fleet management and releases the local handle. It never deletes Pi sessions, credentials, configuration, extensions, skills, prompts, or project files.

## Runtime, data, and maintenance

The short-lived CLI connects to one private per-user runtime. On first operational use, Fleet verifies and materializes an immutable runtime release, then starts it in the background. A registered native service is preferred when present; service management is experimental and not part of the seven-command beta interface.

Linux defaults:

```text
Fleet state:       ~/.local/state/pi-fleet/
Materialized code: ~/.local/share/pi-fleet/releases/
Runtime socket:    $XDG_RUNTIME_DIR/pifleet-$UID/control.sock
                   (or the system temporary directory when XDG_RUNTIME_DIR is absent)
Pi sessions:       Pi's normal ~/.pi storage or the exact path you selected
```

`PIFLEET_STATE_ROOT` and `PIFLEET_APPLICATION_ROOT` can override Fleet-owned locations. A CLI invocation whose state root differs from an installed service fails with repair guidance instead of connecting to the wrong database.

`npx @elpapi42/pi-fleet@beta` is appropriate for evaluation, but global installation is recommended for continued use. Fleet materializes a verified runtime independently of the npm cache or installation; evaluation can intentionally leave runtime and Fleet state behind.

Before uninstalling, destroy handles you no longer want Fleet to manage:

```bash
pifleet list --human
pifleet destroy HANDLE
npm uninstall --global @elpapi42/pi-fleet
```

Removing the npm package does not delete Pi sessions, Fleet SQLite state, materialized releases, or an already-running runtime/service. Reinstalling the same or compatible version reconnects to preserved state. There is no automatic self-update, telemetry, remote transport, or npm `postinstall` service registration. Database migrations are forward-only; installing an older binary after a newer schema migration is not rollback.

## Beta status

Beta.9 has passed deterministic Linux x64 fault, recovery, package, compatibility, systemd/PID-1 restart, and resource-stability tests with Pi `0.80.10`. Its tag workflow verifies the exact registry artifact, provenance, and a fresh global-install operational smoke.

Known limits:

- Linux x64 is the only validated support target. Arbitrarily hoisted local-prefix, pnpm, and unusual `npx` dependency layouts are not supported.
- Disposable systemd/PID-1 restart and user-lingering recovery are validated; a full host logout and kernel reboot are not.
- macOS launchd and descendant containment, real disk exhaustion, and multi-hour resource growth remain unvalidated.
- Runtime upgrades are not automatic, and active runtimes are not silently replaced.
- Session tails cannot promise exactly-once delivery under arbitrary external mutation.
- A promptless missing session path can remain physically unmaterialized until Pi writes conversation content, following native Pi behavior.
- Managed Pi `0.80.10` pins `brace-expansion@5.0.6`, affected by local glob-input denial-of-service advisory `GHSA-3jxr-9vmj-r5cp`. Beta.9 permits only that exact package/version/path/advisory in the production-audit gate; every additional or changed production vulnerability fails release. Tracking: [earendil-works/pi#6882](https://github.com/earendil-works/pi/issues/6882).

For support, include `node --version`, `pifleet --version`, `pifleet list`, and `pifleet status HANDLE`. Do not include API keys, message contents, session contents, or private paths unnecessarily. Report reproducible issues at <https://github.com/elpapi42/pi-fleet/issues>.

## Development

```bash
npm ci
npm run audit:production
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

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for architecture and release gates, and [`TESTING_PLAN.md`](./TESTING_PLAN.md) for fault injection, crash recovery, concurrency, privacy, and soak testing.

## License

MIT © elpapi42
