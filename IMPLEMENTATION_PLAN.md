# Pi Fleet Implementation Plan

## Outcome

Build Pi Fleet as a small TypeScript CLI and one local runtime that keeps named Pi processes available, while leaving Pi sessions entirely under user control.

```text
create named agent → resident Pi process → send normal Pi input
→ receive latest assistant text after idle → restore same observed session when absent
```

Fleet owns names, process lifecycle, ordered prompt delivery, latest observed text, and restoration references. Pi and the user own session paths, IDs, creation, migration, configuration, extensions, and deletion.

## Non-negotiable product rules

- Native Pi arguments belong after the first literal `--` and retain their exact order.
- `--session`, `--session-id`, `--session-dir`, `--fork`, and `--continue` remain native Pi controls. Fleet neither copies nor deletes sessions.
- Fleet owns `--cwd` because Pi has no native cwd option.
- `send` uses RPC `prompt` with `streamingBehavior: "steer"` and returns after Pi acknowledgement.
- `receive` waits for idle and returns Pi's latest assistant text; it is not tied to one `send`.
- `watch` emits raw complete records from the selected Pi session JSONL, without Fleet wrappers.
- `destroy` stops Fleet management and its process, but never deletes Pi session files or user configuration.

## Architecture

```text
CLI → FleetClient → private Unix socket → Fleet runtime
                                         ├── FleetStore
                                         ├── PiAdapter
                                         ├── AgentCoordinator
                                         └── platform process/socket support
```

The CLI never starts Pi directly or accesses durable state. The runtime is the only owner of a live Pi process. An asynchronous `FleetStore` allows an in-memory implementation to prove the product flow before SQLite replaces it.

## Milestones

### 1. Tooling and architecture foundation — complete

Create a strict TypeScript ESM package with separate CLI/runtime bundles, test/lint/format/build scripts, Node `^22.19.0 || ^24.0.0` gating, and a small shared utility layer. `pifleet --version` works; other invocations clearly report that Fleet is not implemented. No runtime, socket, Pi, SQLite, or service behavior is added.

**Exit gate:** clean install, typecheck, lint, format check, tests, and build pass; the CLI bundle has no runtime/store/Pi imports.

### 2. Real-Pi compatibility probe — complete on Linux x64 / Pi 0.80.10

Probe the exact managed Pi artifact in isolated temporary roots. Verify native selectors (no selector, `--session`, `--session-id`, `--session-dir`, `--fork`, `--continue`, and headless `--resume`), resolved path/ID observation, restoration argv, prompt-with-steer acknowledgement, busy/idle boundary, latest assistant text, session materialization, and clean process recovery.

**Exit gate:** a tracked redacted compatibility profile and deterministic fake-Pi contract exist. Do not assume selector restoration behavior.

**Evidence:** `test/fixtures/pi-compatibility-profile.json` and `fake-pi-contract.json` prove native selector handling, local deterministic prompt/steer/settlement/latest-text behavior, first materialization, and clean shutdown on Linux x64. Headless `--resume` does not enter RPC mode and is unsupported in v1; macOS parity remains a release gate.

### 3. Pure CLI contract

Implement all seven command grammars against a fake client. Freeze JSON-first output, `--human` for six finite commands, stdin `-`, name validation, timeout parsing, cwd handling, exact passthrough, and raw `watch` output.

**Exit gate:** command/unit tests cover all public grammar and stdout/stderr/exit-code contracts.

### 4. Private socket and fake runtime

Add versioned bounded Unix-socket JSONL, a typed client, a foreground fake runtime, `MemoryFleetStore`, operation identities for mutations, and held `receive`/`watch` connections.

**Exit gate:** built CLI communicates with a separate runtime process and private protocol frames never leak to public output.

### 5. Real-Pi in-memory vertical slice

Implement the first end-to-end flow with one agent: promptless `create`, resident reuse, `send`, idle-based `receive`, status/list, clean process loss, restoration of the observed native session, and non-destructive `destroy`.

**Exit gate:** real Pi proves `create → send → receive → second send → restore after clean process loss` without copying or deleting a session.

### 6. Native selector matrix and raw watch

Complete selector-specific restoration behavior and tail the exact selected session file from EOF or first materialization. Detect obvious replacement/truncation but do not promise exactness under arbitrary external concurrent writers.

**Exit gate:** every supported selector has first-launch/restoration tests and watch output matches ordinary appended session records byte-for-byte.

### 7. SQLite durability and recovery

Replace the memory store behind the same async interface. Persist agents, ordered send certainty, process-incarnation evidence, operation results, observed session references, and latest assistant text. Never add work-cycle, per-message-response, or Fleet session ownership tables.

**Exit gate:** runtime restart preserves names/latest text, never replays ambiguous sends, and prevents a second Fleet writer before old-process absence is proven.

### 8. Packaging and native supervision

Close CLI/runtime/Pi artifacts, test `npm pack` and materialized runtime behavior, then add systemd user-service and launchd support. Service removal must leave Pi sessions untouched.

**Exit gate:** supported packaged Linux x64 and macOS arm64 installations create, send, receive, watch, restore, and destroy agents under supervision.

## Sequencing

Milestones 2 and 3 can proceed in parallel after Milestone 1. Then execute 4 → 5 → 6 → 7 → 8 sequentially. SQLite, packaging, and service installation must not precede the real-Pi vertical proof.

## Explicit exclusions

No copied/Fleet-owned sessions, session deletion, one-response-per-send semantics, work-cycle/disposition schemas, Pi protocol patch, workflow engine, terminal parsing, remote transport, public daemon controls, idle eviction, telemetry, self-update, or npm lifecycle service registration.

## Evidence-gated decisions

Do not guess: resolved session observation, selector restoration argv, headless `--resume`, stable Pi idle signal, SQLite thread placement, resident capacity, stream/record limits, and Linux/macOS descendant cleanup.
