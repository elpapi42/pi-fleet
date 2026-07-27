# pi-fleet

**Pi orchestration beyond terminal scale.**

pi-fleet is local, Pi-native execution infrastructure for programs that coordinate long-lived Pi agents. It keeps one shared per-user pool reachable through a TypeScript SDK and a JSON-first CLI while every native Pi session remains under the user's control.

**Control execution. Own the session. Build the orchestration above it.**

## Why pi-fleet exists

Terminal multiplexers such as tmux, cmux, and Herdr are useful for human-facing panes. Programmatic orchestration needs different primitives: stable agent addresses, immutable generation identity, ordered steering or follow-up input, process and recovery state, replayable high-level activity, and explicit uncertainty after a crash.

pi-fleet supplies those execution primitives. It does not define roles, workflows, schedules, dashboards, semantic retries, memory policy, or autonomy. Agents act only on explicit instructions unless a higher layer implements its own bounded policy.

## Requirements and installation

The current support target is **Linux x64**, Node.js `^22.19.0 || ^24.0.0`, and a separately installed **Pi 0.82.1** executable. pi-fleet launches the Pi selected by the invoking environment; it never bundles, copies, or substitutes Pi.

```bash
command -v pi
pi --version # 0.82.1
npm install --global @elpapi42/pi-fleet@beta
pifleet --version
```

pi-fleet resolves `pi` and `node` from the invoking `PATH` and persists their absolute selected paths for supervised startup. `PIFLEET_PI_EXECUTABLE=/absolute/path/to/pi` is an advanced override. Shell aliases and functions are unsupported.

Configure provider credentials before starting the persistent runtime. Environment variables added only to later commands do not change an already-running runtime.

## TypeScript SDK

The SDK ships in the same npm package as the CLI and runtime:

```ts
import { connectPiFleet } from "@elpapi42/pi-fleet/client";

const fleet = await connectPiFleet();
const reviewer = await fleet.create({
  name: "reviewer",
  cwd: process.cwd(),
  instructions: "Review the current change.",
});

const events = await reviewer.receive(); // live from attachment
console.log("attached at", events.cursor);

await reviewer.send("Focus on lifecycle races."); // steering by default
await reviewer.send("Then check documentation.", { delivery: "followUp" });

for await (const event of events) {
  if (event.type === "assistant.message.finished") {
    console.log(event.text);
  }
}
```

`connectPiFleet()` connects to the shared per-user control plane; it does not create a private pool. Agents created through one SDK client are immediately addressable by other SDK clients and the CLI. `client.close()` closes only that client's local resources and receive streams—it never stops the runtime or shared agents.

Use `connectPiFleet({ autoStartRuntime: false })` when another process owns control-plane startup; connecting still verifies the runtime is reachable and protocol-compatible, so it fails with `runtime_unavailable` when nothing is running and `protocol_incompatible` against an older runtime, which is left untouched. Imports are inert, and passive operations remain available when Pi is missing; Pi is validated only for `create`, `send`, and `compact`.

### Agent handles and input

`client.create()` and `client.get()` return remote `Agent` handles; `client.list()` returns lightweight summaries for discovery. A handle carries both the reusable friendly name and the immutable creation UUID, so an old handle cannot retarget a later same-name recreation.

`agent.send()` means durable acceptance and ordering, not task completion or one-send/one-response correlation.

- `delivery: "steer"` is the default and matches ordinary Pi prompt/steering behavior.
- `delivery: "followUp"` asks Pi to queue input until it finishes current work. Pi only queues
  follow-up input for a run that is already in flight, so pi-fleet delivers follow-up input to an
  authoritatively idle session as an ordinary prompt instead. Follow-up delivery is therefore best
  effort: input accepted in the narrow window while a turn is ending may be queued against a run
  that never resumes, and no later turn will carry it. Use `steer` when delivery must be certain.
- Cancellation stops only the caller's wait; it does not cancel accepted remote work.

### Continuous receive

`agent.receive()` is a passive broadcast stream and never wakes or restores Pi. Any number of consumers may attach independently.

```ts
await agent.receive(); // live from invocation
await agent.receive({ after: cursor }); // replay strictly after a cursor, then follow live
await agent.receive({ fromStart: true });
```

The returned stream exposes its initial opaque `cursor` before its first event. Each event has its own stable ID and cursor; lifecycle pairs share an activity ID. Delivery is at-least-once after reconnect, so consumers should checkpoint cursors and deduplicate by event ID.

The public event model contains exactly six types:

- `assistant.thinking.started` / `assistant.thinking.finished`
- `assistant.message.started` / `assistant.message.finished`
- `tool.execution.started` / `tool.execution.finished`

There are no public deltas, raw RPC frames, turn events, retry events, or synthetic gap events. Starts mean pi-fleet durably observed meaningful activity begin. A crash may leave a start unmatched; pi-fleet never invents a finish.

After an unclean runtime death that may have left any Pi incarnation alive—even a logically idle one—old streams stop at their last safe cursor with `observation_uncertain`. The error provides the last-safe cursor and, when available, an explicit continuation cursor. Crossing that gap is a caller decision; pi-fleet never bridges it silently.

## CLI

The CLI is a shell adapter over the same shared agents and semantic client contract:

```text
pifleet create NAME [INITIAL_INSTRUCTIONS] [--cwd PATH] [--human] [-- PI_OPTIONS...]
pifleet send NAME MESSAGE [--follow-up] [--human]
pifleet receive NAME [--after CURSOR | --from-start] [--until-idle] [--human]
pifleet status NAME [--human]
pifleet list [--human]
pifleet compact NAME [--human]
pifleet destroy NAME [--human]
```

Finite commands emit one compact JSON object on stdout. Expected failures emit one structured JSON error on stderr. `receive` emits semantic event JSONL on stdout and one readiness record with the initial cursor on stderr. Downstream EPIPE is a successful caller disconnect.

Normal `receive` stays open across work, idle periods, absent Pi processes, and same-agent restorations. `--until-idle` is a CLI-only live convenience: it atomically attaches, emits subsequent events through the exact durable idle boundary, and exits. If the agent is already idle at attachment it exits successfully with no historical output. Historical modes cannot be combined with `--until-idle`.

The former raw `watch` command and finite latest-response receive contract were removed during the beta cutover. Use semantic `receive`; inspect native Pi sessions directly when raw session history is required.

## Native sessions remain yours

`create` assigns a stable local address to a Pi agent and its native session. The process may be resident or absent; the logical agent remains addressable until `destroy`.

- Native selectors after the first literal `--` are passed to Pi in their original order.
- Exact `--session`, `--session-id`, `--session-dir`, `--fork`, and `--continue` choices remain authoritative.
- pi-fleet never copies, relocates, normalizes, wraps, or deletes session files.
- `destroy` stops execution ownership and logically deletes pi-fleet-owned control, journal, and semantic history for that agent UUID while preserving the native session; only a minimal content-free idempotency receipt may remain.
- Deliberate concurrent native-session writers remain possible at the user's risk.

```bash
pifleet create reviewer --cwd /workspace/project -- --session /absolute/session.jsonl
```

`--cwd` is a pi-fleet option before `--`; Pi options come after it. Headless `--resume` and Pi positional prompts are unsupported.

## Persistence, privacy, and failure

pi-fleet durably stores every complete LF-terminated Pi RPC stdout record byte-for-byte before parsing it or exposing derived receive events. This private journal can contain prompts, thinking, tool input/output, paths, extension data, and secrets emitted by Pi. It is retained for the logical agent's lifetime and removed by successful `destroy` as a logical SQLite deletion. pi-fleet does not claim immediate file shrinkage or forensic erasure from WAL files, freelist pages, backups, snapshots, or physical media.

Storage failure is fail-closed: affected work stops, receive ends at the last durable cursor, committed history is preserved, and pi-fleet never bridges an unrecorded gap. Operational diagnostics contain counts, sizes, ages, health, and UUIDs—not retained payloads or paths.

`status` and `list` are passive. An idle agent may be `resident` or `absent`; a later work operation restores an absent process from the concrete native session when safe. Treat `delivery_uncertain`, `compaction_uncertain`, `runtime_interrupted`, `incarnation_cleanup_uncertain`, and session failures conservatively. Semantic retry policy belongs to the orchestrator.

## Destructive beta transition

This release intentionally resets all prior pi-fleet-owned agent, operation, response, and journal state when upgrading the old schema. Native Pi session files are preserved. There is no compatibility alias for raw `watch` or finite receive.

Before the new runtime opens the old database:

1. Finish work on the old runtime.
2. Stop and uninstall only pi-fleet supervision with `dist/installer.mjs uninstall`.
3. Prove the old runtime and Pi process trees are absent.
4. Install supervision from the environment selecting the intended Pi and Node with `dist/installer.mjs install`.
5. Start the new runtime; no old agents are restored automatically.

A responsive older runtime is never killed or replaced automatically. After the destructive schema reset, reinstalling beta.10 or another older binary is **not** rollback; use a forward fix or an externally managed pre-reset state backup. User-owned native sessions remain untouched throughout.

## Runtime locations and service behavior

Linux defaults:

```text
State:       ~/.local/state/pi-fleet/
Releases:    ~/.local/share/pi-fleet/releases/
Socket:      $XDG_RUNTIME_DIR/pifleet-$UID/control.sock
Pi sessions: Pi's normal ~/.pi storage or the exact selected path
```

`PIFLEET_STATE_ROOT` and `PIFLEET_APPLICATION_ROOT` override pi-fleet-owned paths. State, database, WAL, SHM, socket, and immutable-release paths are private and fail closed on unsafe ownership, type, or symlink conditions.

A service whose selected Pi or Node differs from the terminal environment returns `pi_service_mismatch` or `runtime_upgrade_deferred`; it is not silently rewritten. Global installation is recommended for continued use; `npx` is suitable for evaluation only.

## Scope and known limits

- Linux x64 is the only current release target.
- Pi 0.82.1 is the current compatibility target.
- macOS, host logout/reboot, real disk exhaustion, and multi-hour resource behavior require separate validation.
- pi-fleet has no workflow engine, scheduler queue, idle-process eviction, remote transport, telemetry, automatic semantic retry, or automatic service upgrade.
- A promptless missing session path may remain unmaterialized until Pi writes conversation content.

For support, include `node --version`, `pi --version`, `pifleet --version`, `pifleet list`, and `pifleet status NAME`. Do not include credentials, messages, thinking, tool payloads, session contents, cursors, or private paths unnecessarily.

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
npm run test:client-types
npm run test:platform
npm run test:soak
```

## License

MIT © elpapi42
