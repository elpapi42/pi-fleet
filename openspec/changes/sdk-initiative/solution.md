# Product Solution

## What changes for the user?

Local orchestration programs gain a supported TypeScript SDK as the primary programmatic interface to the same shared per-user pi-fleet runtime used by the CLI. SDK clients and CLI commands remain equal peers: an agent created through either interface is immediately visible and usable through the others, and no client owns an agent merely because it created it.

The SDK presents direct `client.create()`, `client.get()`, and `client.list()` operations and returns friendly `Agent` objects for agent-scoped behavior. Closing a client ends only that client's connections and receive streams; it does not stop pi-fleet, Pi, or any shared agent. Agent creation is promptless and separate from communication so a program can establish observation before sending the first instruction.

Programs no longer have to treat agent idleness and one mutable latest response as their communication boundary. `receive` becomes a continuous high-level activity stream that can be opened repeatedly and concurrently by independent clients. It provides semantic start and finish events for thinking, visible assistant messages, and tool execution without requiring consumers to parse Pi RPC output or wait silently for an activity to complete.

The CLI remains concise and name-oriented. It exposes the same shared agents and high-level receive behavior for shell users, while providing a CLI-only mode that streams until the selected agent becomes idle. Public raw `watch` is removed rather than retained as a competing observation model.

One-time and manual use remain straightforward, but continuous long-lived orchestration is the primary behavior. SDK users compose status and receive according to their workflow rather than relying on a separate one-shot task abstraction.

## How should it work?

- pi-fleet maintains one shared pool of logical agents per OS user. All clients under that user have the same authority to resolve, communicate with, observe, compact, and destroy those agents. Profiles, roles, scheduling, routing, aggregation, notifications, approval policy, autonomy, and subordinate-specific reporting remain responsibilities of higher-level systems.

- Every creation has a friendly reusable name and an immutable full UUID. Names are lookup addresses; UUIDs distinguish individual creations. SDK `Agent` objects bind to the UUID returned by creation or lookup. A stale SDK object, cursor, stream, accepted operation, recovery record, or history reference must never target a later agent that reused the same name.

- CLI commands continue accepting friendly names. Each command resolves the name once and binds that invocation to the resolved UUID for its full lifetime. If that UUID disappears, the invocation fails rather than retargeting a replacement. A later independent CLI command intentionally resolves whichever current agent holds the name.

- Creation does not implicitly send work. Programs may create an agent, attach receive, and then send the first instruction.

- Sending defaults to Pi steering and supports an explicit Pi follow-up mode. Successful send means only that input was durably accepted and ordered. It does not promise one corresponding response, task completion, visible text, interruption of a running tool, or a response caused exclusively by that send. Mutation idempotency remains SDK/runtime infrastructure rather than normal caller ceremony.

- pi-fleet durably records every complete Pi stdout RPC record byte-for-byte. Outbound stdin commands are not part of this history. Stored records preserve their original bytes rather than being parsed and reserialized, including internal command responses, extension events, lifecycle records, and unknown future record types. An interrupted trailing fragment is not fabricated into a completed record or semantic event.

- Raw stdout history belongs to the UUID-bound logical agent and remains ordered across Pi process incarnations, runtime interruption and recovery, and internal Pi session creation or switching. Native Pi sessions are not the receive boundary or replay source; they remain user-owned and pi-fleet does not copy, relocate, rewrite, or delete them. Raw history remains internal and is not exposed as a public replacement for `watch`.

- Public receive transforms the retained raw history into pi-fleet's own stable semantic lifecycle events. The complete initial event family is `assistant.thinking.started`, `assistant.thinking.finished`, `assistant.message.started`, `assistant.message.finished`, `tool.execution.started`, and `tool.execution.finished`.

- Every emitted event has its own stable event ID and cursor. Each related start and finish shares a stable activity ID. Correlation depends on the activity ID rather than adjacency because independent clients may attach mid-activity and Pi's observed semantic activities may interleave.

- Each non-empty thinking block produces its own lifecycle pair in observed order. `assistant.thinking.started` is emitted when the first non-empty thinking content is observed. `assistant.thinking.finished` carries that complete thinking block. Entirely empty thinking blocks emit nothing.

- A Pi assistant response with visible text produces one assistant-message lifecycle pair regardless of how many text blocks Pi uses internally. `assistant.message.started` is emitted when the first non-empty visible text is observed. `assistant.message.finished` carries all visible text blocks concatenated without invented separators. A response with no non-empty visible text produces no assistant-message pair; this is not an error, does not erase prior history, does not emit `no_response`, and does not end or interrupt receive.

- Public tool lifecycle represents actual execution, not the model's construction of a tool call. `tool.execution.started` includes the call ID, tool name, and finalized input or arguments. `tool.execution.finished` repeats the call ID, name, and input and adds the final output and error status, so a finish remains independently understandable when a client did not observe its start.

- Starts are durable observations that an activity began, not promises of completion. If Pi or the runtime is interrupted after a start, that event remains in history without a fabricated finish. Agent status or stream termination provides the failure context. Finish events for normally completed activities are self-contained.

- The initial receive contract excludes raw Pi RPC records, partial text or thinking deltas, tool updates, tool-call argument construction, turn events, generic retry events, compaction events, and send-to-response correlation. Direct compaction remains available, but compaction activity is deferred as a receive event.

- Bare SDK and CLI receive begin with future events from the moment attachment is atomically established and stream indefinitely. Callers may explicitly resume after a cursor or replay the logical agent's complete retained history from its beginning. The beginning is the start of pi-fleet's retained history for that UUID, not the start of the current native Pi session.

- Receive is passive. Attaching does not start, restore, or wake Pi and does not consume Pi process capacity.

- Any number of receive invocations may coexist subject to explicit host resource limits. Every invocation has an independent start boundary, cursor, replay position, delivery speed, reconnection, and cancellation. One consumer never consumes events for another or advances a shared checkpoint. Events are ordered per agent and delivered at least once; possible redelivery is identifiable through stable event identity. No cross-agent total order is promised.

- A slow consumer must never block Pi, durable record storage, lifecycle work, or healthy consumers. It may be disconnected with a visible lag/resource error and its last durable position.

- Receive follows the logical agent through idle periods, active work, absent Pi processes, recoverable agent failure, Pi process replacement, runtime interruption and reconnection, and internal Pi session changes. Internal session changes do not terminate, segment, or become a public boundary in the stream. Surviving a runtime interruption means reconnecting and resuming from durable history, not preserving one physical socket.

- A receive stream ends only through caller cancellation, client close, agent destruction, subscriber lag or resource failure, or an unrecoverable storage, runtime, or protocol failure.

- Bare CLI receive streams indefinitely. A CLI-only until-idle option establishes the normal live boundary, emits every subsequent high-level event, and exits only after the resolved UUID becomes idle and all events through that idle boundary have been emitted. If the agent is already idle when attachment completes, it exits successfully with no historical output. Historical output requires an explicit cursor or full-history option.

- SDK users do not receive a special finite helper in the initial scope. They may replay from the beginning after observing idle, replay after a saved cursor, or attach live receive before waiting for idle.

- Raw stdout history is retained for the logical agent's lifetime with no automatic pruning in the initial product. It may contain thinking, tool inputs and results, extension data, paths, provider details, and secrets. Its sensitivity and potentially unbounded disk growth are accepted and documented under the OS-user trust boundary.

- Durable observation is fail-closed. If pi-fleet cannot retain stdout because of disk exhaustion, database failure, worker failure, or bounded persistence pressure, it does not silently continue with a history gap. Affected new work is rejected, affected Pi work is quiesced or stopped as necessary, receive streams end with a typed storage failure and their last durable position, and already committed history remains replayable. Missing intervals are never silently bridged.

- Successful destroy proves the agent process tree is absent, ends streams for its UUID, logically removes all pi-fleet-owned data associated with that UUID, and then frees the name for immediate clean reuse. Deleted data includes raw stdout history, transformed event indexes, launch and agent state, sends, compactions, incarnation records, and other associated SQLite state. A same-name replacement starts with a new UUID and no predecessor history. Native Pi session files remain untouched.

- A minimal content-free destroy receipt may remain so a lost successful destroy response can be retried safely. pi-fleet promises logical deletion from active storage and APIs, not forensic erasure from SQLite pages, WAL files, backups, snapshots, or physical media. Interactions while the name is absent return `agent_not_found`.

- This is a clean beta replacement. There is no dual finite receive API, old watch alias, compatibility mode, or old/new runtime interoperability promise.

## How will we know it worked?

The smallest useful release includes the shared public SDK, UUID-safe agent handles with friendly lookup, steering and follow-up input, byte-faithful durable Pi stdout history, independent replayable receive streams with the six thinking, visible-message, and tool-execution lifecycle events, the CLI until-idle mode, fail-closed storage behavior, complete logical deletion on destroy, and removal of public raw watch.

The direction is proven when a real main-agent extension can create or resolve several persistent reviewer agents, observe them concurrently from independent clients, and promptly learn when thinking, visible answering, or tool execution begins and finishes without parsing Pi RPC or spawning CLI subprocesses. It can correlate lifecycle pairs, understand self-contained finishes after attaching mid-activity, and repeatedly steer or follow up without treating sends as one-to-one response requests.

The extension can restart and resume each receive stream from its own cursor, identify possible redelivery, and continue across Pi process and runtime recovery without silently losing activity pi-fleet declared durable. It can reuse the same logical agents and user-owned native Pi sessions across real assignments with materially less re-explanation.

Shared-resource behavior is demonstrated when SDK-created agents are immediately usable through another SDK client and the CLI, and CLI-created agents are immediately usable through the SDK. Parallel receive consumers progress independently without blocking one another.

Identity and deletion behavior is demonstrated when an agent is destroyed and recreated with the same name: old handles, cursors, operations, streams, and history cannot target or appear in the replacement; all active pi-fleet data for the destroyed UUID is gone; and the user-owned native Pi session remains untouched.

Reliability is demonstrated under empty assistant messages, multiple thinking blocks, long-running tools, mid-activity attachment, subscriber lag, Pi interruption, runtime restart, and storage failure. Empty assistant or thinking content does not create misleading lifecycle noise, independent starts and finishes preserve observed order, an interrupted activity may retain an unmatched start but is never fabricated as finished, slow consumers do not block healthy work, and storage failure stops affected work rather than creating an unreported observation gap.

Profiles, scheduling, routing, notifications, cross-agent ordering, exactly-once delivery, server-owned consumer checkpoints, raw public protocol access, generic task-completion inference, and subordinate-specific reporting remain outside the first product scope.
