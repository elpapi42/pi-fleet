# Technical Specification

## What exists today?

- pi-fleet is a strict TypeScript ESM package for Linux x64. `package.json` publishes the `pifleet` executable and immutable runtime artifacts, but it has no public SDK export, exports map for client code, or declaration bundle. CLI commands use an internal `FleetClient`/`SocketFleetClient` seam through injected dependencies; external programs must spawn CLI processes or speak an unsupported private protocol.

- One central per-user runtime owns logical agent state, Pi process trees, Pi RPC stdin/stdout, SQLite, lifecycle reconciliation, and a private pathname Unix socket. `src/runtime/control-server.ts` handles one finite request per connection, except the held raw-watch stream. A first public SDK can therefore hide one private socket per receive stream without committing the public API to physical connection multiplexing.

- The private protocol is major version 2. `src/protocol/envelope.ts` models finite response envelopes plus raw-watch ready/chunk/end/error frames. Runtime-version matrix tests prove that an incompatible responsive runtime is preserved: pi-fleet returns `protocol_incompatible` without replacing its PID, socket inode, service definition, or immutable runtime release.

- `src/pi/process.ts` owns child-process RPC transport. It receives arbitrary stdout `Buffer` chunks, invokes the current raw-byte callback, then immediately buffers, strips framing details, decodes JSON, resolves correlated requests, and publishes parsed frames. This is the correct byte-fidelity observation point but not a durability gate: parsing, RPC acknowledgement, and lifecycle effects do not wait for persistent storage.

- All Pi spawn paths already establish the stdout callback before startup traffic: initial creation, restoration for send, and restoration for compaction. The new journal must preserve that ordering so startup command responses and extension events are captured.

- Public `watch` currently tees exact Pi RPC stdout bytes through `src/runtime/rpc-watch-hub.ts`. It is transient, name-keyed, bound to one process incarnation, non-replayable, and backed by per-subscriber byte queues. It cannot provide durable logical-agent receive semantics and must not be extended into the new receive implementation.

- Current `receive` is finite and idle-gated. `src/runtime/agent-coordinator.ts` calls `get_last_assistant_text` after settlement and stores one mutable `latestAssistantText`/`responseObservedAt` snapshot. Empty latest assistant text can replace a previously retrievable visible boundary with `null`. There is no ordered response or activity history, stable event identity, cursor, replay, or replay-to-live handoff.

- Pi 0.82.1 RPC provides the required semantic sources. `message_update.assistantMessageEvent` includes `thinking_delta`, `thinking_end`, `text_delta`, and `text_end` with `contentIndex`; `message_end` contains finalized ordered assistant content; `tool_execution_start` contains `toolCallId`, `toolName`, and `args`; and `tool_execution_end` contains call ID, name, result, and error status but omits arguments. Pi exposes no durable assistant-message ID suitable for public activity identity.

- Steering currently uses RPC `prompt` with `streamingBehavior: "steer"`, preserving extension commands, input hooks, skills, and prompt-template expansion. Pi follow-up is a distinct typed `follow_up` RPC command rather than direct steering or a pi-fleet queue convention.

- `src/store/sqlite-store.ts` and `src/store/worker-store.ts` provide a single dedicated SQLite worker with `foreign_keys=ON`, WAL, `synchronous=FULL`, checksummed transactional migrations, newer-schema refusal, unclean-shutdown `quick_check`, and terminal worker-failure propagation. Current schema version 2 stores agents, operations, sends, compactions, incarnations, and runtime metadata, but no raw RPC journal, semantic event index, cursor state, continuity epochs, or compound append API.

- Existing storage ownership is inconsistent with reusable names. Agent creation already assigns a full immutable UUID and some compact-operation recovery validates it, but sends, incarnations, and several recovery paths remain primarily name-keyed. Current `deleteAgent` removes the agent row only; associated operation, send, compaction, and incarnation rows can remain because the schema has no UUID-wide ownership/cascade model.

- Current store calls and worker requests have no admission priority or bounded pending-request queue. Existing watch fan-out bounds subscriber memory, but durable stdout ingestion creates a different pressure boundary: persistence backlog must pause or stop Pi rather than drop records, while a slow semantic receiver must read later without affecting Pi.

- State directories and the private socket use restrictive modes, and immutable runtime materialization validates ownership and symlink safety. SQLite state-root setup does not yet apply the same complete owner/type/symlink validation or explicitly harden the DB, WAL, and SHM files, despite the new journal retaining thinking, tool inputs/results, extension data, paths, errors, and possible secrets.

- Production uses a separately installed external Pi selected by absolute executable and Node paths. Passive control-plane startup remains possible while Pi is unavailable; create, send, and compact validate Pi identity immediately before accepting or dispatching work. Linux systemd definitions use `UMask=0077`, `KillMode=control-group`, restart-on-failure, and immutable runtime paths. macOS and non-x64 platforms are outside this package's current supported claim.

- Directional disposable SQLite evidence confirms exact BLOB round trips for invalid UTF-8, NUL, CRLF, and LF bytes, ordered WAL reads during appends, and a near-8 MiB record. On one host, bounded batches materially reduced FULL-synchronous commit overhead relative to one transaction per small record. This establishes basic viability, not release throughput, disk-pressure, or long-duration retention thresholds.

## What should change?

- Keep one npm package, `@elpapi42/pi-fleet`, containing the CLI, runtime, installer, and public SDK. Within that package, publish the side-effect-free ESM import subpath `@elpapi42/pi-fleet/client` with generated TypeScript declarations; this is an import boundary, not a separate package or installation. It exports `connectPiFleet` and the supported public client, agent, receive-stream, event, cursor, option, and error types. Importing the client subpath must not touch the filesystem, inspect Pi, start the runtime, open sockets, install services, or import runtime/store/Pi-process implementation graphs.

- `connectPiFleet()` is the explicit connection boundary. By default it discovers or starts the shared central control-plane runtime; an option disables automatic runtime startup. Starting the control plane must not start Pi or require Pi to be currently available. A responsive incompatible runtime must fail with `protocol_incompatible` and remain untouched.

- The public client exposes direct create/get/list operations and returns UUID-bound `Agent` proxy objects for send, status, receive, compact, and destroy. SDK methods throw one stable public `PiFleetError` family rather than exposing internal `Result` envelopes or wire frames. Mutation operation IDs remain automatically generated SDK/runtime infrastructure, with only an advanced retry override if required; local `AbortSignal` cancellation cancels the caller's wait or stream and never implies remote work cancellation.

- SDK clients, CLI commands, and other programs access the same per-user agent pool. Closing a client closes only that client's sockets and receive streams. It must not stop the runtime, Pi, or shared agents.

- Keep friendly names as lookup addresses and make the existing full creation UUID the correctness identity. Every SDK `Agent` stores the UUID observed during create/get. Every CLI command resolves the name once and carries that expected UUID for the command lifetime. All durable operations, sends, compactions, incarnations, journal records, semantic events, projector state, cursors, continuity epochs, receive streams, destruction, and recovery paths must be UUID-scoped. If the UUID disappears or the name now points to another UUID, the old operation fails and never retargets the replacement.

- Bump the private protocol major. Replace finite idle/latest-text receive and raw public watch with a distinct held semantic-receive method and typed stream frames. Remove old receive/watch compatibility methods, aliases, and capability shims. The CLI and public SDK ship with the matching runtime protocol as one release closure.

- Keep one physical Unix-socket connection per receive invocation initially and hide that choice behind the SDK. Do not add connection-level multiplexing, stream IDs, or public raw-socket support in this scope. Private receive frames must support bounded segmentation and SDK reassembly so a retained semantic event larger than the current 1 MiB control-frame limit remains deliverable. Cancellation or disconnection before complete reassembly must not advance the emitted-event cursor; reconnect replays from the preceding cursor.

- Extend send with an explicit delivery mode. The default continues to call Pi `prompt` with `streamingBehavior: "steer"`. Follow-up calls Pi's typed `follow_up` RPC. Both share existing durable ordering, idempotency, preflight, no-replay, and uncertainty machinery. Send acceptance continues to make no response-correlation or task-completion promise.

- Replace schema version 2 with a forward-only schema that begins from clean UUID-owned invariants. This beta cutover intentionally discards all existing pi-fleet-owned agents, operations, sends, compactions, incarnations, response snapshots, and receipts; it performs no history or state backfill. The reset must validate the known migration ledger, prove the old runtime and owned process trees absent, and replace the schema transactionally. Failure before commit restores the original schema; after commit, older binaries refuse the newer schema and binary rollback is unsupported. Native Pi session files are never opened, copied, rewritten, moved, truncated, or deleted by the reset.

- A new client that finds a responsive old runtime must not start migration, unlink its socket, replace its service, kill its processes, or activate a new runtime. Transition remains explicit: quiesce and stop or uninstall old supervision, prove process-tree absence, then activate the new runtime with the selected external Pi and Node paths. No old/new runtime or schema coexistence mode is required.

- Keep SQLite as the sole durable source for logical state, exact raw history, semantic event rows, projector state, positions, and continuity epochs. Store raw records as binary data outside `agents.data_json`; retained history must not make list/status reads scale with transcript size. Use immutable UUID-scoped records with per-agent monotonic raw positions. Preserve the complete original LF-terminated bytes, including any CR before LF, and record incarnation/source metadata needed for diagnostics. Do not claim a cross-agent total order.

- Maintain a versioned immutable semantic-event index beside the raw journal. Semantic rows carry a per-agent monotonic event position, stable event ID, shared activity ID where applicable, source raw position, event type, complete public payload, timestamp evidence, continuity epoch, and projector version. Raw history remains authoritative; the index is deterministically rebuildable, but normal startup must use bounded persisted projector state rather than scan an agent's lifetime history.

- Keep Pi-specific projection outside the storage implementation. A deterministic lifecycle projector consumes a complete framed record plus minimal prior projector state and produces compound append data. The store atomically commits raw records, derived semantic events, projector state, per-agent high-water positions, and any related lifecycle facts without interpreting Pi event semantics or exposing generic SQL transactions to `FleetService`.

- Replace the current tee-and-immediate-parse path with one ordered ingestion authority per incarnation feeding a globally bounded and fair persistence scheduler. It must:
  - frame arbitrary stdout chunks into exact complete LF-terminated records without using chunk boundaries as record boundaries;
  - establish journal ownership before every Pi spawn;
  - bound pending records, pending bytes, per-agent bytes, partial-record bytes, open projector activities, and maximum batch age;
  - avoid repeated whole-record copying through segmented accumulation or equivalent bounded framing;
  - pause and resume the affected child stdout stream at ingestion high/low water marks;
  - prioritize durability writes over historical replay reads;
  - use bounded micro-batches by count, bytes, and age while preserving each agent's relative order;
  - expose no RPC acknowledgement, extension request, lifecycle transition, idle high-water mark, or receive event sourced from a batch until its transaction commits; and
  - wait for child stdout close and durable ingestion drain before declaring an incarnation cleanly ended.

- Parsing may inspect a complete record before commit to prepare deterministic projection, but it must have no externally observable effect before commit. For a valid known record, raw bytes, semantic events, and projector state commit together. Unknown records commit with no semantic event. Malformed JSON, invalid UTF-8, unsupported or oversized parsed frames, and deterministic projection failures must retain the exact complete raw bytes and durable failure evidence before failing the affected Pi protocol path. An interrupted trailing fragment is never promoted to a complete record. A source that exceeds bounded partial-record staging without LF is stopped and marked failed rather than consuming unbounded memory or disk.

- RPC deadlines and error classification must distinguish Pi failing to produce a matching response from a matching response that has entered bounded durable ingestion but has not committed yet. The latter is storage/backpressure state, must never be reported as Pi non-response, and must never trigger replay. A successful commit permits normal response completion; persistence failure produces the corresponding storage/continuity failure.

- Project exactly these six initial public event types:
  - `assistant.thinking.started`
  - `assistant.thinking.finished`
  - `assistant.message.started`
  - `assistant.message.finished`
  - `tool.execution.started`
  - `tool.execution.finished`

- Thinking projection is per content block. Meaningful content requires at least one non-whitespace character. The first meaningful `thinking_delta`, or a meaningful `thinking_end` when no prior meaningful delta exists, emits `assistant.thinking.started`. `thinking_end` emits the matching finish with the complete original block text, including any surrounding whitespace. Empty or whitespace-only thinking blocks emit nothing. Multiple blocks preserve observed source order and have distinct activity IDs.

- Visible assistant-message projection is per finalized Pi assistant response, not Pi's internal message envelope or each text block. Meaningful visible content requires at least one non-whitespace character. The first meaningful `text_delta`, or meaningful `text_end` without a prior meaningful delta, emits one `assistant.message.started`. `message_end` emits one matching finish containing all finalized visible text blocks concatenated without invented separators and preserving their original content. A response without meaningful visible text emits no assistant-message pair and is not an error.

- `tool_execution_start` emits `tool.execution.started` with call ID, tool name, and finalized arguments. Persist those arguments in bounded open-activity state because Pi's end event omits them. `tool_execution_end` emits a self-contained finish repeating call ID, name, and input and adding final output and error status. Tool-call token construction and tool updates remain internal raw history.

- Each started and finished event has its own stable event ID and cursor. The pair shares a stable activity ID. Derive identities from durable UUID, continuity epoch, committed raw position, and deterministic semantic subposition rather than unavailable or unstable Pi message IDs. Clients correlate pairs by activity ID, not adjacency. Public order follows committed Pi observation order; no invented nesting rule is promised.

- A committed start is evidence that pi-fleet durably observed activity begin, not a promise that a finish will arrive. Normal completion emits the self-contained finish. Pi/process/runtime interruption may leave unmatched starts in retained history; never synthesize a finish, abort event, or completion result.

- Do not expose text/thinking deltas, tool updates, tool-call construction, turns, retries, compaction lifecycle, raw RPC records, or send-to-response correlation in this event version. Unknown future Pi records remain retained but produce no public event until a later explicitly versioned projector supports them.

- Implement receive as durable database range reading rather than per-subscriber event queues. A receive invocation must atomically resolve and validate the expected UUID, select its boundary, register for wakeups, and return an initial opaque cursor before the first event. Supported boundaries are live-from-attachment by default, strictly after a validated cursor, and from the beginning of retained history.

- The initial cursor represents the atomic attachment boundary and is persistable before any event arrives. Every event carries the cursor immediately after that event. Cursors bind at least the agent UUID, continuity epoch, and semantic position, are opaque to callers, and reject same-name recreation, wrong-agent use, invalid versions, deleted history, and unacknowledged continuity gaps.

- Each receive stream performs bounded keyset-paginated semantic reads, writes bounded segmented frames, waits for socket drain, and re-queries after lightweight live notifications. Notifications are wake-up hints only; missed notifications cannot cause missed events because SQLite is authoritative. Allow at most one outstanding range read per stream, globally bound replay pressure, and prioritize journal appends over historical reads. A slow consumer consumes bounded socket/task resources and reads later from SQLite; it never pauses Pi or accumulates memory proportional to its lag.

- `await agent.receive()` returns a `ReceiveStream` async iterable only after the atomic attachment boundary is established. `ReceiveStream.cursor` exposes that initial opaque cursor before any event arrives; every yielded event carries its successor cursor. The SDK may reconnect automatically from the last event emitted to the caller only when continuity is proven. Applications own durable checkpoints and deduplicate possible at-least-once redelivery using stable event IDs. pi-fleet creates no durable consumer identity, shared consumed position, or server-owned checkpoint.

- Receive remains passive. Attaching to an absent agent does not restore Pi or consume process capacity. A receive stream follows its UUID through ordinary idle/working transitions, clean process replacement, internal Pi session changes, and clean runtime restart. Destroy, client cancellation, protocol/storage failure, invalid cursor, or uncertain observation continuity terminates the affected stream with a stable typed error and last safe cursor.

- Represent observation continuity with durable epochs. Clean runtime shutdown must stop accepting new work, drain Pi stdout and journal ingestion, and close without a gap. An unclean runtime death with no potentially live Pi incarnation creates no gap. An unclean death with any potentially live incarnation creates an internal observation gap even when the last logical state was idle, because timers or extensions may have produced unrecorded output.

- Automatic reconnect and old cursors must never cross an observation gap. Replay stops with `observation_uncertain`, the last safe cursor, and—once a later epoch exists—an opaque continuation cursor. A caller crosses only by explicitly starting from that continuation cursor. Bare live receive after recovery attaches to the current epoch. Uncertainty remains stream/error metadata and does not add a seventh semantic event.

- Replace CLI receive with the same semantic stream. Bare `pifleet receive NAME` attaches live and streams indefinitely. Explicit cursor and from-start modes use the same SDK/protocol boundaries. CLI `--until-idle` atomically establishes the live boundary, then exits only after a durably observed idle high-water mark and delivery of all semantic events through that mark. If already idle at attachment, it exits successfully with no history. `agent_settled` triggers durable state verification and high-water advancement; it is not itself a semantic receive event.

- Successful destroy must prove the target process tree absent, terminate UUID-bound streams, and commit one UUID-wide logical deletion before freeing the name. Deletion covers raw records, semantic events, projector state, continuity epochs, launch/agent state, sends, compactions, incarnations, and agent-bound operations. It must not affect a same-name replacement or any user-owned native session file.

- A minimal content-free destroy receipt may remain outside the UUID-owned deletion boundary for safe idempotent retry. It may retain mutation identity, method, destroyed UUID, terminal status/time, and a non-content fingerprint required to reject operation-ID reuse. It must not retain prompts, raw events, thinking, tools, session paths, launch arguments, cwd, provider data, or process details, and it must not reserve the friendly name.

- Logical deletion does not promise immediate database-file shrinkage or forensic erasure from SQLite pages, WAL/freelist data, backups, snapshots, or storage media. Configure and operate WAL checkpointing and incremental page reclamation so destroyed history can eventually release reusable space without requiring a blocking full `VACUUM` as the only mechanism. Disk-pressure accounting includes DB, WAL, and SHM.

- Treat durable ingestion health as execution safety state. Disk exhaustion, SQLite failure, worker failure, queue exhaustion, or inability to durably commit must reject new affected work, pause/quiesce/stop affected Pi processes as required, terminate affected receive streams with a typed storage error and last durable cursor, preserve committed records, and never bridge an unrecorded interval. Subscriber slowness remains isolated and must not trigger Pi backpressure.

- Validate and harden default and custom state roots as current-user-owned, non-symlink directories with private permissions before opening sensitive state. SQLite DB/WAL/SHM and related temporary files must be private to the OS user. Runtime logs, diagnostics, metrics, and public errors must expose counts, positions, codes, and redacted paths where safe, never raw retained content.

- Expose operational diagnostics for main DB/WAL/SHM bytes, per-agent retained record/event counts and bytes, ingestion backlog records/bytes/age, last successful commit, storage health, open projector activities, active receive streams, replay-reader pressure, checkpoint state, and continuity uncertainty. Exact public CLI exposure is not required in this scope, but tests and incident diagnosis must not depend on logging sensitive payloads.

- Keep current resident-process capacity semantics. Supporting at least 100 logical agents and passive receive streams does not claim 100 simultaneously resident or working Pi processes. Process-starting operations above configured capacity continue to return `capacity_exceeded`; this initiative adds no scheduler queue or idle eviction policy.

- Limit this release to Linux x64 and the validated external Pi 0.82.1 contract. Do not claim macOS, launchd, non-x64, physical-host logout/reboot persistence, or compatibility with arbitrary Pi versions through this initiative. Import/runtime manifests and release packaging must contain no managed Pi fallback.

## How will we validate it?

- Add deterministic byte-ingestion tests covering arbitrary chunk splits/coalescing, LF and CRLF preservation, invalid UTF-8, NUL bytes, empty records, unknown JSON, malformed JSON, multiple records per chunk, trailing partial data, bounded unterminated data, and records near, at, and beyond parser/protocol limits. Assert exact source bytes equal stored BLOB bytes and that no parsed effect occurs before commit.

- Fault-inject every durability boundary: before raw append, during compound append, before/after transaction commit, during projector-state persistence, on worker exit, `SQLITE_FULL`/real disk exhaustion where available, checkpoint failure, queue saturation, and runtime/process termination during drain. Hold a matching RPC response inside durable admission to prove that commit produces normal success while persistence failure produces a storage/continuity error rather than Pi timeout or replay. Assert committed records are replayable, uncommitted effects are invisible, no input is silently replayed, Pi is paused/stopped when required, and no observation gap is silently crossed.

- Test the pure projector against exact Pi 0.82.1 record fixtures and recorded real-Pi sequences. Cover multiple thinking blocks; empty thinking; non-empty content arriving only at an end event; multiple text blocks; empty visible responses; interleaved observed activity; tool start/end with input repetition; duplicate/malformed lifecycle records; unknown future records; interruption after each started event; and deterministic event/activity IDs after restart and replay.

- Prove that raw record, semantic rows, projector state, lifecycle state, and high-water positions are atomic. Crash-recovery tests must never expose a semantic event without its raw source or a committed source that normal operation silently skips. Rebuilding the derived index from raw history under the same projector version must reproduce IDs, order, payloads, and activity relationships exactly.

- Test receive boundary linearization for live attachment, after-cursor replay, from-start replay, and replay-to-live handoff under concurrent append. Verify the initial cursor is available before the first event, no event is lost between snapshot and live wakeup, possible redelivery has stable IDs, cancellation affects only one stream, and independent clients never advance each other's positions.

- Test clients attaching between lifecycle start and finish. Each finish must be interpretable without its start: thinking finish carries complete thinking, message finish carries complete text, and tool finish repeats call ID/name/input plus result/error. Replay from the beginning must preserve both sides and observed order; correlation must rely on activity ID rather than adjacency.

- Test semantic wire segmentation with payloads below, at, and above the private frame limit. Verify SDK reassembly yields one `AgentEvent`, disconnect during reassembly does not advance the cursor, replay restarts the event from its preceding cursor, and client/server memory remains bounded.

- Test 100 durable logical agents and at least 100 independent passive receive streams while respecting configured Pi-process capacity. Exercise simultaneous live receivers, long historical replay, slow sockets, cancellation, reconnect, and concurrent journal writes. Assert replay reads are bounded/fair, journal writes retain priority, slow consumers do not increase Pi backpressure, FDs/RSS/heap remain within evidence-based thresholds, and no hidden work queue appears above resident capacity.

- Establish realistic SQLite load and soak evidence with real/synthetic Pi record distributions: small delta bursts, large tool results, mixed agents, bounded micro-batch latency, concurrent range reads, WAL/checkpoint growth, destroy/reclamation cycles, and long-duration retention. Testing must set release thresholds for append latency, semantic-start delay, queue depth/age, memory, FDs, WAL growth, and recovery time rather than treating the directional local spike as proof.

- Validate continuity epochs under clean and unclean shutdown. Clean runtime/process shutdown must drain without a gap. Unclean runtime death with no live incarnation must reconnect without a gap. Unclean death with working and idle-resident Pi incarnations must stop old cursors with `observation_uncertain`; timers/extensions are included in the idle-resident case. Verify no automatic crossing, correct last-safe cursor, explicit continuation into the next epoch, default live attachment to the current epoch, and no synthetic semantic gap event.

- Validate CLI `--until-idle` races: already idle at attachment, thinking/message/tool events immediately before settlement, successor activity, compaction, concurrent send/follow-up, destroy, storage failure, and runtime interruption. Exit must occur only after the resolved UUID is durably idle and every semantic event through its idle high-water mark has been emitted.

- Validate steering and follow-up against real external Pi 0.82.1. Steering must preserve extension-command/input-hook/skill/template behavior and active queue semantics. Follow-up must use typed `follow_up` and wait behind active work. Both must preserve durable ordering, idempotent retry, no silent replay, capacity handling, and uncertainty classification.

- Build schema-reset fixtures from populated production schema version 2, including agents and orphan-prone operations/sends/compactions/incarnations. Prove one transactional reset yields an empty valid new schema, removes every old pi-fleet-owned row, preserves referenced native session files byte-for-byte, and rolls back to intact schema v2 under injected migration failure. Older runtimes must reject the committed newer schema.

- Prove migration cannot start while an old runtime or owned process tree remains. A new SDK/CLI against released protocol-v2 runtimes must return `protocol_incompatible` without changing PID, socket inode, service definition, database, or immutable releases. Concurrent new startup after explicit transition must converge on one runtime and one migration.

- Test UUID isolation across every durable path. Destroy and recreate the same name while exercising stale SDK handles, CLI invocations, sends, compactions, receive cursors, streams, operation retries, recovery records, and continuity metadata. Every stale reference must fail without touching the replacement.

- Test successful destroy as process absence plus atomic UUID-wide deletion. Query all new tables to prove no agent-owned row remains, verify the name is reusable immediately after commit, verify native sessions remain byte-identical, and prove retry through the minimal receipt cannot destroy or reveal a same-name replacement. Document and test logical deletion separately from physical file-size reclamation.

- Validate state-root security using owned/unowned directories, symlinks, wrong file types, permissive modes, custom roots, DB/WAL/SHM creation, detached startup, and systemd. Unsafe ownership or path identity must fail closed before sensitive state opens; diagnostics must remain content-free and redacted.

- Package-test the public SDK from tarball and fresh registry installation. Verify the client export and declarations resolve from ESM TypeScript and plain JavaScript, importing is inert, runtime-only modules are absent from the client graph, direct methods and UUID-bound `Agent` types match runtime behavior, and SDK-created agents are immediately visible and usable from another SDK client and the CLI and vice versa.

- Run isolated full lifecycle tests against external Pi 0.82.1 and a privileged disposable PID-1/systemd environment. Cover create, receive-before-send, thinking/message/tool lifecycle, steer, follow-up, compact, process restoration, runtime restart, active and idle-resident unclean restart, storage recovery, destroy, no eager Pi restoration, one-writer session continuity, and preservation of user-owned sessions. This evidence must not be described as physical-host logout/reboot or macOS validation.

- Dogfood the problem-defining workflow with a main-agent extension and several persistent reviewer agents. Use multiple independent clients, repeated assignments, tools, multiple thinking blocks, visible responses, mid-activity attachment, client/runtime restarts, cursor checkpoint/replay, deliberate interruption, same-name recreation, and CLI inspection. Success requires useful prompt lifecycle visibility without CLI subprocess orchestration or raw RPC parsing, no silent loss of declared-durable activity, identifiable redelivery, and materially less re-explanation across assignments.
