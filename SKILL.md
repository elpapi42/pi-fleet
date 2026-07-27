---
name: pi-fleet-operator
description: Use pi-fleet's SDK or CLI to create, communicate with, observe, compact, and destroy shared local Pi agents while preserving user-owned native sessions. Invoke for long-lived multi-agent orchestration, steering or follow-up input, continuous semantic receive, cursor recovery, lifecycle inspection, and conservative failure handling.
compatibility: Requires Linux x64, Node.js ^22.19.0 or ^24.0.0, pifleet, and a separately installed Pi 0.82.1 executable.
---

# pi-fleet operator

Use pi-fleet as Pi-native execution infrastructure, not as a terminal multiplexer or workflow engine. pi-fleet controls execution; the user controls the native session; the calling program owns roles, scheduling, aggregation, semantic retries, and autonomy.

## Prefer the SDK for orchestration

The supported TypeScript entry is part of the same package:

```ts
import { connectPiFleet } from "@elpapi42/pi-fleet/client";
```

All SDK clients and the CLI address one shared per-user agent pool. `client.close()` closes only local resources. It must never stop shared agents or the runtime.

Use direct client methods:

```ts
const fleet = await connectPiFleet();
const agent = await fleet.get("reviewer");
const events = await agent.receive();
await agent.send("Review this change.");
```

Agent handles carry an immutable creation UUID as well as the reusable friendly name. Never reconstruct a handle from a name when an existing handle is available; a stale handle must fail rather than retarget a same-name recreation.

Use `connectPiFleet({ autoStartRuntime: false })` only when another process owns control-plane startup; connecting still performs a passive reachability and protocol check, so it fails immediately with `runtime_unavailable` or `protocol_incompatible` rather than returning a handle that breaks later. Imports are inert. Passive list/get/status/receive/destroy behavior must remain available when Pi is unavailable; work operations validate Pi when invoked.

## Establish the local execution context

Before the first work-accepting operation:

```bash
command -v pifleet
pifleet --version
command -v pi
pi --version
```

The supported Pi target is 0.82.1. pi-fleet launches the selected Pi and Node paths; it does not bundle Pi. Do not install, upgrade, repair, restart, or replace supervision unless the user requests maintenance.

Never test against the user's default state unless explicitly asked. Isolate at least `HOME`, `XDG_RUNTIME_DIR`, `PIFLEET_STATE_ROOT`, `PIFLEET_APPLICATION_ROOT`, `PI_CODING_AGENT_DIR`, and `PIFLEET_DISABLE_REGISTERED_SERVICE=1`.

## Reuse before creating

Use `client.list()`, `client.get(name)`, `pifleet list`, or `pifleet status NAME` before creating when continuity may be useful.

Names are stable local addresses, not personas. They use 1–63 lowercase letters, digits, or interior hyphens:

```text
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

Create through the SDK or CLI:

```ts
const agent = await fleet.create({ name: "reviewer", cwd: "/workspace/project" });
```

```bash
pifleet create reviewer --cwd /workspace/project
pifleet create reviewer "Initial instructions" --cwd /workspace/project
```

Native Pi options follow the first literal `--` in exact order. `--cwd` belongs before it.

## Preserve native sessions

Pi sessions are user-owned native resources. Exact selectors remain authoritative:

```bash
pifleet create reviewer --cwd /workspace/project -- --session /absolute/session.jsonl
pifleet create reviewer -- --session-id SESSION_ID
pifleet create reviewer -- --fork /absolute/source.jsonl
pifleet create reviewer -- --continue
```

pi-fleet never copies, relocates, normalizes, wraps, or deletes native sessions. Successful destroy logically deletes pi-fleet-owned state and journal history for that agent UUID, not the session file. Do not imply forensic erasure of SQLite WAL/freelist pages or external backups.

## Send steering or follow-up input

Steering remains the default:

```ts
await agent.send("Check the failure path.");
await agent.send("Then summarize the contract.", { delivery: "followUp" });
```

```bash
pifleet send reviewer "Check the failure path"
pifleet send reviewer "Then summarize" --follow-up
```

Follow-up delivery is best effort. Pi queues follow-up input only for a run already in flight, so
pi-fleet sends follow-up input to an authoritatively idle agent as an ordinary prompt. Input
accepted in the narrow window while a turn is ending can be queued against a run that never
resumes, and no later turn carries it; prefer default steering when delivery must be certain.

A successful send proves durable acceptance and ordering only. It does not prove completion, imply one response, or correlate one send to one event. Multiple sends may steer one active cycle. Cancellation stops the local wait, not accepted remote work.

Use explicit `-` for stdin; pi-fleet never consumes piped stdin implicitly.

## Receive continuous semantic activity

Receive is passive and continuous. Attach before sending when observation timing matters:

```ts
const stream = await agent.receive();
const checkpoint = stream.cursor;
for await (const event of stream) {
  // Persist event.cursor after processing and deduplicate by event.id.
}
```

Start modes are:

```ts
await agent.receive();
await agent.receive({ after: checkpoint });
await agent.receive({ fromStart: true });
```

The stream contains exactly six lifecycle event types:

- `assistant.thinking.started` / `assistant.thinking.finished`
- `assistant.message.started` / `assistant.message.finished`
- `tool.execution.started` / `tool.execution.finished`

Each event has an event ID and cursor; each pair shares an activity ID. Tool finishes repeat the finalized input and add output/error state. Empty thinking or visible text emits no public lifecycle pair. There are no public deltas, retry events, raw RPC records, or turn events.

An observed start may remain unmatched after interruption. Never fabricate a finish or infer semantic completion from agent idleness.

Any number of receive streams may coexist. Consumers own checkpoints. Delivery after reconnect is at-least-once, so deduplicate by event ID.

After `observation_uncertain`, stop at the last-safe cursor. Crossing to the supplied continuation cursor requires an explicit caller decision. Never silently bridge the gap.

## Use the CLI as a shell adapter

```bash
pifleet receive reviewer                    # live, continuous JSONL
pifleet receive reviewer --after CURSOR     # replay then follow
pifleet receive reviewer --from-start       # retained history then follow
pifleet receive reviewer --until-idle       # live one-off projection
```

Readiness and the initial cursor are written to stderr. Semantic event JSONL is written to stdout. `--until-idle` cannot be combined with history; it exits with no history if already idle and otherwise emits through the exact observed idle boundary.

The old raw `watch` command and finite latest-response receive contract no longer exist. Do not parse terminal output, raw Pi RPC, logs, or native session tailing as a substitute for semantic receive.

## Inspect and compact conservatively

`status` and `list` are passive and never restore Pi:

```bash
pifleet status reviewer
pifleet list
```

An idle agent may be resident or absent. Never infer logical continuity from a PID.

Compact only an idle agent:

```ts
await agent.compact();
```

```bash
pifleet compact reviewer
```

Compaction is a typed Pi control, not an assistant response. Treat `compaction_uncertain` as potentially applied and never retry automatically.

## Handle failure without replay

Treat these as policy boundaries:

- `runtime_interrupted`: active work stopped; pi-fleet did not replay it.
- `delivery_uncertain`: Pi may have received input; replay may duplicate side effects.
- `observation_uncertain`: receive history has a crash gap; explicit continuation is required.
- `incarnation_cleanup_uncertain`: an old writer may remain; do not force a replacement.
- `storage_unavailable`: durable recording failed; affected work and streams stop at the last safe cursor.
- `session_unavailable` or `session_ambiguous`: continuity cannot safely be claimed.

A new send is new work, not proof that uncertain earlier work had no effect. Ask for user or orchestration policy before semantic retry.

## Destroy deliberately

```ts
await agent.destroy();
```

```bash
pifleet destroy reviewer
```

Destroy only when pi-fleet should stop owning execution. It removes pi-fleet-owned control and journal history after process absence is proven, but preserves native Pi sessions, configuration, credentials, extensions, skills, prompts, and project files.

Do not destroy a reusable agent merely because one assignment completed.

## Respect retention and output boundaries

The private durable journal stores every complete Pi RPC stdout record before parsing. It can contain prompts, thinking, tools, paths, extension data, and secrets for the agent's lifetime. Do not expose journal payloads in logs, errors, diagnostics, or reports.

Finite CLI commands emit one JSON object on stdout. Receive emits JSONL only. Keep stderr separate. Treat receive EPIPE as normal local disconnection. Do not use `--human` for programmatic orchestration.

## Service and destructive beta transition

A changed Pi/Node selection or responsive incompatible runtime must fail closed. Do not force repair.

For the destructive beta schema transition:

1. Finish old work.
2. Run the installed `dist/installer.mjs uninstall` to remove only supervision.
3. Prove the old runtime and Pi process trees are absent.
4. Run `dist/installer.mjs install` from the intended Pi/Node environment.
5. Accept that prior pi-fleet-owned agents and history reset; native sessions remain.

After reset, an older binary is not rollback. Use a forward fix or an externally managed pre-reset state backup.

## Report outcomes

Report the pi-fleet agent address, operation, lifecycle/residency state when relevant, processed event cursor, and any uncertainty boundary. Never expose credentials, raw history, thinking, tool payloads, session contents, cursors not needed by the recipient, or unnecessary private paths.
