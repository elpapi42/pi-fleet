# Testing

## Environment parameters

1. Record the exact source commit and whether the subject is a source checkout, local tarball with SHA-256, or immutable npm version. Do not mix evidence from different artifacts.
2. Use Linux x64 and record distribution, kernel, cgroup version, Node, and npm versions. Node must satisfy `^22.19.0 || ^24.0.0`; CI currently uses Node `24.16.0`.
3. Set external Pi explicitly and verify exact version `0.82.1`:

   ```bash
   export PIFLEET_PI_EXECUTABLE="$(command -v pi)"
   export PIFLEET_PI_NODE="$(command -v node)"
   "$PIFLEET_PI_EXECUTABLE" --version
   ```

   Do not use a managed Pi dependency or rely on `node_modules/.bin/pi`.

4. Before every direct CLI/runtime test, create and export a unique disposable root; never run direct behavior against the user's default runtime or sessions:

   ```bash
   export ROOT="$(mktemp -d -t pifleet-sdk-test.XXXXXX)"
   mkdir -p "$ROOT/home" "$ROOT/runtime" "$ROOT/state" "$ROOT/application" "$ROOT/pi-agent" "$ROOT/evidence"
   chmod 700 "$ROOT/home" "$ROOT/runtime" "$ROOT/state" "$ROOT/application" "$ROOT/pi-agent"
   export HOME="$ROOT/home"
   export XDG_RUNTIME_DIR="$ROOT/runtime"
   export PIFLEET_STATE_ROOT="$ROOT/state"
   export PIFLEET_APPLICATION_ROOT="$ROOT/application"
   export PI_CODING_AGENT_DIR="$ROOT/pi-agent"
   export PIFLEET_DISABLE_REGISTERED_SERVICE=1
   export PIFLEET_PI_EXECUTABLE="$(command -v pi)"
   export PIFLEET_PI_NODE="$(command -v node)"
   ```

   Follow `.pi/skills/isolated-cli-black-box-validation/SKILL.md` for containment, but follow this change's specification rather than stale watch/finite-receive behavior in older skill prose.

5. Use deterministic scripted Pi and local provider fixtures for ordinary validation. Do not request or use production credentials. The final reviewer dogfood may use only explicitly authorized development credentials and test-owned sessions.
6. Require Docker or equivalent privileged disposable-container access with cgroup v2 only for real ENOSPC and PID-1/systemd checks. Never fill the host filesystem.
7. Store stdout, stderr, event cursors/IDs/activity IDs, PIDs, SQLite diagnostics, provider ledgers, session paths/hashes, resource samples, artifact identity, and command exit statuses under a test-owned evidence directory without copying secrets into general logs.

## Phase-level verification

1. Before phase checks, establish a clean baseline:

   ```bash
   npm ci
   npm run audit:production
   npm run typecheck
   npm run lint
   npm run format:check
   npm run build
   ```

2. After Phase 1, run focused unit/type/static checks for event unions, UUID targeting, cursors, error registry, runtime limits, steering/follow-up RPC requests, and durability-aware response state:

   ```bash
   npm run typecheck
   npm run lint
   npx vitest run test/unit --maxWorkers=1
   npm run build
   npm pack --dry-run --json
   ```

   Confirm active protocol remains v2, active schema remains v2, CLI still has its pre-cutover behavior, and no SDK export appears in the packed artifact.

3. After Phase 2A, run the shared store and migration contracts against dormant memory and SQLite implementations:

   ```bash
   npm run typecheck
   npx vitest run test/integration/store-contract.test.ts test/faults/storage-and-redaction.test.ts --maxWorkers=1
   ```

   Verify exact BLOB round trips for invalid UTF-8, NUL, LF, and CRLF; monotonic UUID-scoped raw/event positions; atomic compound append; keyset reads; cursor/epoch metadata; bounded open activities; same-name generation isolation; complete UUID-wide deletion; and content-free destroy receipts.

4. After Phase 2A, build a populated real schema-v2 fixture containing agents, sends, operations, compactions, incarnations, and latest-response data plus a test-owned native session hash. Exercise the inactive migration directly: successful cutover yields an empty valid new schema and unchanged session bytes; injected failure after destructive DDL begins restores intact schema v2; normal runtime startup still leaves schema v2 untouched.
5. After Phase 2B, run the focused pure-component suites (using the finalized framer/projector test paths created with the implementation):

   ```bash
   npm run typecheck
   npx vitest run test/unit/lifecycle-projector.test.ts test/unit/rpc-record-framer.test.ts --maxWorkers=1
   ```

   Feed exact Pi 0.82.1 records into the projector and cover multiple thinking blocks, first meaningful content arriving at delta or end, whitespace-only suppression, original whitespace preservation, multiple visible text blocks, empty visible responses, tool input repetition, interrupted starts, malformed/duplicate transitions, unknown records, deterministic identities, and exclusion of deltas/turns/retries/compaction/tool construction.

6. After Phase 2B, exercise the record framer with every chunk split/coalescing arrangement, multiple records per chunk, one record across many chunks, LF/CRLF, invalid UTF-8, NUL, malformed JSON, empty records, oversized complete records, and trailing or over-budget unterminated data. Stored-record expectations must use exact bytes, not decoded strings.
7. After Phase 2C, run the finalized receive-pager and segmentation suites:

   ```bash
   npm run typecheck
   npx vitest run test/unit/receive-pager.test.ts test/unit/semantic-segmentation.test.ts --maxWorkers=1
   ```

   Verify the dormant receive pager establishes an initial cursor atomically, performs live/from-start/after-cursor reads, transitions replay to live without gaps, uses wakeups only as hints, and keeps independent positions. Exercise segmentation below, at, and above the private frame limit; interrupted reassembly must not advance the event cursor.

8. After Phase 3, run the implemented dormant vertical-slice, safety-contract, service-preflight, and response-admission suites:

   ```bash
   npm run build
   npx vitest run test/unit/journal-runtime.test.ts test/unit/phase-three-foundations.test.ts test/unit/journal-store.test.ts test/unit/pi-process.test.ts test/integration/service-installer.test.ts --maxWorkers=1
   npm run test:version-matrix
   ```

   Exercise arbitrary stdout chunks through compound journal commit, semantic projection, replay boundaries, centralized limit mapping, content-free diagnostics, clean-drain ordering, state-path hardening, and pre-socket/pre-database ownership checks without selecting the new runtime path. Hold matching RPC responses in durability admission to distinguish an admitted response from Pi non-response; active storage/continuity failure behavior remains a Phase 4 proof.

9. After Phase 3, verify state-root handling for private owned directories, permissive owned directories, symlinks, non-directories, wrong ownership, custom roots, and DB/WAL/SHM modes. Unsafe roots must fail before sensitive state opens, and diagnostics must not expose canary content.
10. After Phase 3, verify a responsive protocol-v2 runtime and its socket, PID, service definition, database, and process tree remain untouched when new startup detects incompatibility. No destructive migration may begin through that path.
11. After Phase 4, run the exact coordinated-cutover matrix:

    ```bash
    npm run build
    npm run test:integration
    npm run test:faults
    npm run test:process
    npm run test:compat
    npm run test:version-matrix
    ```

    Confirm the coordinated activation exposes only the new protocol, continuous semantic receive, UUID targeting, steering/follow-up, and seven-command CLI while released old runtimes return `protocol_incompatible` without replacement or database open/migration. Phase-4 implementation must replace or remove obsolete raw-watch/finite-receive assertions as their production surfaces disappear so this matrix remains green at the cutover boundary.

12. After Phase 4, replace finite receive/raw-watch assertions with continuous receive cases: `ReceiveStream.cursor` exists before the first event; live default emits future events only; from-start and after-cursor replay correctly; replay-to-live is gapless; finishes are self-contained after mid-activity attachment; cancellation is isolated; destroy ends only the target UUID; and no raw Pi or seventh gap event appears.
13. After Phase 4, verify the durability gate: no RPC acknowledgement, extension request, lifecycle state, semantic event, or idle high-water mark becomes visible before its source transaction commits; stdout pauses/resumes at bounds; one noisy agent cannot starve another; process completion waits for stdout close and journal drain; malformed/unknown/oversized complete records persist before protocol failure.
14. After Phase 4, run the continuity matrix: clean shutdown drains without a gap; unclean death with no potentially live Pi has no gap; unclean death with working Pi and idle-resident Pi produces `observation_uncertain`; automatic reconnect and old cursors stop at the last safe position; explicit continuation enters the next epoch; bare live receive attaches to the current epoch.
15. After Phase 4, verify CLI `--until-idle` when already idle, during thinking/message/tool work, around settlement, with successor activity, concurrent steer/follow-up, compaction, destroy, storage failure, and runtime interruption. It must emit every event through the durable idle high-water mark and never infer completion from an uncommitted `agent_settled`.
16. After Phase 5A, run the source-level public-client and shared-pool suites through the internal client-only entry:

    ```bash
    npm run typecheck
    npx vitest run test/unit/sdk-entry.test.ts test/unit/sdk-facade.test.ts test/unit/sdk-transport.test.ts test/unit/sdk-connector.test.ts test/unit/sdk-error-boundary.test.ts test/integration/socket-runtime.test.ts --maxWorkers=1
    ```

    Confirm direct methods, UUID-bound `Agent`, `ReceiveStream.cursor`, reconnect boundaries, shared-agent behavior, and import-time inertness without requiring the npm `/client` subpath to exist before Phase 6.

17. After Phase 5A, prove SDK/CLI shared-pool behavior: SDK-created agents appear through CLI, CLI-created agents appear through SDK, two clients receive independently, client close leaves agents/runtime alive, passive connection works without Pi, and stale handles/cursors cannot target a same-name replacement.
18. After Phase 5B, run operational/fault coverage and exercise DB/WAL/SHM accounting, bounded checkpointing, incremental reclamation, write-priority replay, logical deletion, redacted diagnostics, and storage-health transitions:

    ```bash
    npm run build
    npx vitest run test/unit/phase-five-operations.test.ts test/unit/journal-worker-store.test.ts test/unit/phase-three-foundations.test.ts --maxWorkers=1
    npm run test:faults
    npm run test:platform
    ```

    Distinguish row deletion/reusable pages from immediate file shrinkage or forensic erasure.

19. After Phase 6, run package integrity and clean-consumer checks:

    ```bash
    npm run build
    npm run test:package
    npm run test:client-types
    npm run release:check
    npm pack --dry-run --json
    ```

    Install the packed artifact into clean JavaScript and strict-TypeScript consumers; verify `import { connectPiFleet } from "@elpapi42/pi-fleet/client"` resolves with declarations and is inert before connection. Confirm one package contains CLI/runtime/installer/SDK, contains no managed Pi, exposes no obsolete watch/finite-receive contract, and materialized runtime integrity agrees with package protocol/schema/client identity.

## Final verification

1. Run the complete static and automated matrix from a clean checkout with external Pi configured:

   ```bash
   npm ci
   npm run audit:production
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   npm run test:faults
   npm run test:process
   npm run test:platform
   npm run test:compat
   npm run test:package
   npm run test:client-types
   npm run test:version-matrix
   npm run test:soak
   npm run benchmark:store
   npm run release:check
   ```

2. Inspect the isolated SQLite database after journal activity with `PRAGMA quick_check`, `PRAGMA foreign_key_check`, and the migration ledger. Expect `quick_check=ok`, no foreign-key rows, and the exact current checksum/version; use store APIs or finalized table names for UUID-deletion assertions rather than guessing schema names.
3. Fault-inject before raw append, during compound append, before/after commit, during projector-state persistence, on worker exit, queue saturation, checkpoint failure, simulated `SQLITE_FULL`, and shutdown drain. Require committed replay, invisible uncommitted effects, no input replay, correct Pi pause/stop, and explicit last-safe cursors.
4. Run real ENOSPC only in a disposable bounded filesystem or privileged container. Classify injected SQLite-full and kernel ENOSPC as separate evidence and preserve disk/WAL/backlog diagnostics.
5. Exercise semantic payloads below, at, and above the 1 MiB control-frame limit and Pi records near and above parser limits. Require bounded segment reassembly, no partial public event, replay from the preceding cursor after interruption, and exact retained raw bytes.
6. Run a 100-agent/100-passive-stream matrix with slow and fast consumers, historical replay concurrent with appends, one outstanding range read per stream, and configured resident-process capacity unchanged. Measure RSS, heap, Linux FDs, DB/WAL/SHM bytes, append latency, semantic-start delay, queue depth/age, checkpoint duration, and recovery time; set release thresholds from repeated baselines rather than claiming 100 resident Pi processes.
7. Through an isolated packed CLI/SDK environment, create an agent, establish receive and save its initial cursor, send deterministic work that produces all six event types, attach a second receiver mid-tool, send a follow-up, restart cleanly and resume, induce one explicit uncertainty gap, cross only with the continuation cursor, then destroy. Preserve event/order/cursor/activity evidence and verify the native session remains.
8. Against external Pi 0.82.1, prove steering uses slash-aware `prompt` with `streamingBehavior: "steer"`, active steering joins actual long-running work, follow-up uses typed `follow_up` and waits behind active work, extension commands/hooks/skills/templates remain available through steer, and ambiguous work is never replayed.
9. Use `.pi/skills/linux-systemd-persistence-validation/SKILL.md` in a privileged disposable PID-1/systemd environment, adapted to continuous receive: install the exact candidate and external Pi, prove clean restart without a gap, unclean working and idle-resident restart with explicit gaps, no eager Pi restoration, one later writer on the same session, explicit schema transition only after old process absence, and native-session preservation. Do not claim physical-host reboot/logout or macOS evidence.
10. Dogfood the problem-defining workflow with a main-agent extension and several persistent reviewer agents. Establish independent SDK receive streams before sends; observe multiple thinking pairs, message pairs, and tool-execution pairs; steer and follow up across repeated assignments; attach mid-tool; checkpoint/restart clients; cleanly restart runtime; explicitly cross one uncertain gap; inspect the same agents through CLI; and prove same-name recreation rejects old handles/cursors. Success requires timely understandable lifecycle progress without CLI subprocess orchestration or raw RPC parsing and materially less re-explanation across assignments.
11. Verify complete logical destroy by querying every UUID-owned store relation, checking that the friendly name is immediately reusable only after process absence and commit, retrying through the minimal receipt without affecting the replacement, and comparing native-session SHA-256 before/after.
12. Verify observability exposes only counts, positions, health, sizes, and redacted safe details. Search captured logs/errors for seeded prompt, thinking, tool-input, tool-output, session-path, and provider canaries; none may appear outside intentionally returned semantic events or test-owned raw DB inspection.
13. Clean up by cancelling test-owned streams, destroying only isolated agents, stopping exact isolated runtime/Pi/provider process groups, proving no process/open file remains under the root, preserving selected evidence, and removing only the test-owned root/container/image.

## Watchouts

- Older isolation and systemd skills contain stale finite-receive/raw-watch wording; reuse their containment and evidence rules, not obsolete command semantics.
- `npm test` does not include every fault/process/platform/version-matrix/soak/benchmark gate.
- Some integration/package suites consume built `dist` artifacts; rebuild before treating their failures as product defects.
- Injected `SQLITE_FULL` is not proof of real ENOSPC, and a container PID-1 restart is not a physical host reboot or logout.
- Durable history makes SQLite latency part of Pi RPC latency; measure semantic-start delay and matching-response storage delay separately from Pi/provider latency.
- A slow receiver should create read lag, not ingestion backpressure. Only persistence backlog may pause or stop Pi.
- One hundred logical agents/streams does not imply one hundred resident processes; current default resident capacity remains 32 unless independently changed.
- Raw history and semantic payloads may contain secrets. Keep isolated roots/evidence private and never paste retained content into generalized CI logs.
- Database logical deletion and physical disk reclamation are different assertions.
- Classify every external scenario as passed, product failure, harness failure, blocked, or not validated; absent output is not success unless bootstrap and stream readiness were proven.
