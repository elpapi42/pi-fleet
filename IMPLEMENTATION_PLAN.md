# pi-fleet Implementation Plan

## Outcome

Build pi-fleet as a small TypeScript CLI and one local runtime that runs Pi beyond one terminal while leaving native Pi sessions entirely under user control.

```text
create pi-fleet entry → resident Pi process → send normal Pi input
→ receive latest assistant text after idle → restore same observed session when absent
```

pi-fleet owns names, process lifecycle, ordered prompt delivery, latest observed text, and restoration references. Pi and the user own session paths, IDs, creation, migration, configuration, extensions, and deletion.

## Non-negotiable product rules

- Native Pi arguments belong after the first literal `--` and retain their exact order.
- `--session`, `--session-id`, `--session-dir`, `--fork`, and `--continue` remain native Pi controls. pi-fleet neither copies nor deletes sessions.
- pi-fleet owns `--cwd` because Pi has no native cwd option.
- `send` uses RPC `prompt` with `streamingBehavior: "steer"` and returns after Pi acknowledgement.
- `receive` waits for idle and returns Pi's latest assistant text; it is not tied to one `send`.
- `watch` emits raw complete records from the selected Pi session JSONL, without pi-fleet wrappers.
- `destroy` stops pi-fleet management and its process, but never deletes Pi session files or user configuration.

## Architecture

```text
CLI → FleetClient → private Unix socket → pi-fleet runtime
                                         ├── FleetStore
                                         ├── PiAdapter
                                         ├── AgentCoordinator
                                         └── platform process/socket support
```

The CLI never starts Pi directly or accesses durable state. The runtime is the only owner of a live Pi process. An asynchronous `FleetStore` allows an in-memory implementation to prove the product flow before SQLite replaces it.

## Milestones

### 1. Tooling and architecture foundation — complete

Create a strict TypeScript ESM package with separate CLI/runtime bundles, test/lint/format/build scripts, Node `^22.19.0 || ^24.0.0` gating, and a small shared utility layer. `pifleet --version` works; other invocations clearly report that pi-fleet is not implemented. No runtime, socket, Pi, SQLite, or service behavior is added.

**Exit gate:** clean install, typecheck, lint, format check, tests, and build pass; the CLI bundle has no runtime/store/Pi imports.

### 2. Real-Pi compatibility probe — complete on Linux x64 / Pi 0.80.10

Probe the exact managed Pi artifact in isolated temporary roots. Verify native selectors (no selector, `--session`, `--session-id`, `--session-dir`, `--fork`, `--continue`, and headless `--resume`), resolved path/ID observation, restoration argv, prompt-with-steer acknowledgement, busy/idle boundary, latest assistant text, session materialization, and clean process recovery.

**Exit gate:** a tracked redacted compatibility profile and deterministic fake-Pi contract exist. Do not assume selector restoration behavior.

**Evidence:** `test/fixtures/pi-compatibility-profile.json` and `fake-pi-contract.json` prove native selector handling, local deterministic prompt/steer/settlement/latest-text behavior, first materialization, and clean shutdown on Linux x64. Headless `--resume` does not enter RPC mode and is unsupported in v1; macOS parity remains a release gate.

### 3. Pure CLI contract — complete

Implement all seven command grammars against a fake client. Freeze JSON-first output, `--human` for six finite commands, stdin `-`, name validation, timeout parsing, cwd handling, exact passthrough, and raw `watch` output.

**Exit gate:** command/unit tests cover all public grammar and stdout/stderr/exit-code contracts.

**Evidence:** `test/unit/cli-contract.test.ts` exercises all seven commands, exact first-`--` passthrough, explicit stdin, JSON/human output, raw watch bytes, timeout exit 124, and structured parser errors against a typed fake `FleetClient`.

### 4. Private socket and fake runtime — complete

Add versioned bounded Unix-socket JSONL, a typed client, a foreground fake runtime, `MemoryFleetStore`, operation identities for mutations, and held `receive`/`watch` connections.

**Exit gate:** built CLI communicates with a separate runtime process and private protocol frames never leak to public output.

**Evidence:** `test/integration/socket-runtime.test.ts` proves real Unix-socket create/list/status/destroy, operation replay/conflict behavior, and typed errors. A built-artifact smoke proves automatic runtime startup and the full fake create/send/receive/watch/destroy path.

### 5. Real-Pi in-memory vertical slice — complete

Implement the first end-to-end flow with one agent: promptless `create`, resident reuse, `send`, idle-based `receive`, status/list, clean process loss, restoration of the observed native session, and non-destructive `destroy`.

**Exit gate:** real Pi proves `create → send → receive → second send → restore after clean process loss` without copying or deleting a session.

**Evidence:** `test/process/real-pi-lifecycle.test.ts` runs Pi 0.80.10 against a local deterministic provider and proves promptless creation, resident reuse, idle-based latest-text receive, clean process release, restoration through the same observed native session, conversation continuity, and non-destructive destroy.

### 6. Native selector matrix and raw watch — complete

Complete selector-specific restoration behavior and tail the exact selected session file from EOF or first materialization. Detect obvious replacement/truncation but do not promise exactness under arbitrary external concurrent writers.

**Exit gate:** every supported selector has first-launch/restoration tests and watch output matches ordinary appended session records byte-for-byte.

**Evidence:** the executable compatibility profile covers existing/missing path, exact ID, custom directory, fork, continue, and unsupported headless resume. `test/process/session-tail.test.ts` and the socket integration suite prove current-EOF, first-materialization, replacement failure, private-frame removal, and byte-identical complete-record delivery.

### 7. SQLite durability and recovery — complete

Replace the memory store behind the same async interface. Persist agents, ordered send certainty, process-incarnation evidence, operation results, observed session references, and latest assistant text. Never add work-cycle, per-message-response, or pi-fleet session ownership tables.

**Exit gate:** runtime restart preserves names/latest text, never replays ambiguous sends, and prevents a second pi-fleet writer before old-process absence is proven.

**Evidence:** shared memory/SQLite store contract tests cover agents, operations, sends, incarnations, clean and unclean reopen, persistent operation replay, pending-versus-dispatching reconciliation, pending create/destroy resumption, migration checksum verification, and newer-schema refusal. Repeated sends are accepted in durable per-agent order and queue behind singular restoration. Receive waiter registration is serialized with idle observation to prevent missed settlement. The real-Pi restart test proves latest-response polling stays passive and restore-on-send reopens the same conversation. A 1,000-operation worker-store benchmark selected one SQLite worker for the runtime; performance remains an operational measurement rather than a public latency guarantee.

### 8. Packaging and native supervision — Linux implementation complete; macOS release gate open

The runtime resolves the pinned `@earendil-works/pi-coding-agent@0.80.10` RPC entrypoint by default, while retaining an explicit development-target override. Builds produce separate CLI, runtime, SQLite-worker, and installer ESM artifacts plus source maps and metafiles. The runtime manifest hashes pi-fleet artifacts and recursively hashes every copied production dependency package; materialization copies only those declared dependency trees into a private staged release and verifies the complete closure before atomic activation.

Linux process groups receive bounded stdin close, SIGTERM, and SIGKILL escalation. systemd user-service and launchd LaunchAgent definitions are implemented; the internal installer supports idempotent install, repair, and uninstall, detects changed/missing recorded Node or runtime targets, and never removes Pi sessions or pi-fleet state. Runtime startup prefers a registered native service and uses detached startup only as the development fallback.

Concrete configurable defaults bound admission and streams: 32 resident/starting processes, 128 watchers, 512 KiB messages, 1 MiB private protocol frames, and 8 MiB Pi/session records. Process-slot reservation occurs before spawn, duplicate restoration attempts cannot start a second process, each watch observes the record bound, and private socket backpressure prevents an unbounded per-client queue.

**Local evidence:** package tests execute a materialized runtime from an unrelated directory, run the full seven-command flow against an exact user session, prove that destroy leaves the session intact, and detect both pi-fleet-artifact and nested dependency corruption. Linux cleanup now verifies the entire dedicated process group—not only its leader—before releasing an agent. Installer repair preserves an existing custom state root when the invoking environment omits it. Watch tests cover bounded incremental reads, oversized complete records, transport backpressure, and unexpected runtime EOF. Orderly shutdown distinguishes idle release from interrupted active work. An actual systemd crash test proved: one resident Pi child before failure, no Pi child after automatic runtime restart, `idle + absent` state, and exactly one restored child only after a later `send` using the same existing session ID. A deliberately broken absolute Node path prevented stable service startup and `installer repair` restored a healthy service and preserved pi-fleet state.

**Remaining release gate:** actual login-session logout and host reboot recovery have not been executed. macOS arm64 launchd execution, logout/reboot behavior, and descendant containment have not been runtime-tested on macOS; its definition is generated and unit/integration-tested only. The `0.1.0-beta.0` public package metadata, npm-installed full-flow test, immutable first-use runtime bootstrap, and OIDC/provenance workflow are implemented. Registry publication and installation from the live npm registry remain blocked only on npm authentication/trusted-publisher setup.

## Sequencing

Milestones 2 and 3 can proceed in parallel after Milestone 1. Then execute 4 → 5 → 6 → 7 → 8 sequentially. SQLite, packaging, and service installation must not precede the real-Pi vertical proof.

## Explicit exclusions

No copied/pi-fleet-owned sessions, session deletion, one-response-per-send semantics, work-cycle/disposition schemas, Pi protocol patch, workflow engine, terminal parsing, remote transport, public daemon controls, idle eviction, telemetry, self-update, or npm lifecycle service registration.

## Evidence-gated decisions

Resolved session observation, selector restoration argv, headless `--resume`, stable Pi idle signaling, SQLite worker placement, bounded defaults, materialized dependency integrity, installer repair, and Linux service crash/restart writer exclusion are decided by tracked Linux/Pi 0.80.10 evidence. The defaults remain configurable and should be revisited only with representative production telemetry supplied by users rather than silently auto-tuned. Actual systemd logout/reboot behavior and all macOS launchd/descendant-cleanup claims remain platform release gates.
