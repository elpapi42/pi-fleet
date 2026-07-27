# pi-fleet SDK and continuous receive proposal

## Status

This document proposes a clean beta redesign of pi-fleet around a public TypeScript SDK and continuous high-level agent event delivery.

The SDK becomes the primary orchestration interface. The CLI remains a shell-friendly and operational interface over the same shared per-user runtime.

This proposal deliberately provides no backward-compatibility layer. The existing finite `receive` contract and public `watch` surface are replaced rather than deprecated or maintained in parallel.

No implementation is included in this document.

## 1. Product model

pi-fleet manages one shared pool of durable agents for each OS user.

```text
Program A ─ SDK ─┐
Program B ─ SDK ─┼─ shared per-user pi-fleet runtime ─ durable agents
CLI command ─────┘
```

Agents are not owned by the client that created them:

- An agent created through the SDK immediately appears in `pifleet list`.
- Another SDK client can resolve and operate it.
- An agent created through the CLI immediately appears to SDK clients.
- CLI and SDK operations are serialized by the same runtime.
- Closing a client does not stop the runtime or affect agents.
- Destroying an agent from any client removes that shared pi-fleet resource.
- Authority is scoped to the OS user; there are no per-client restrictions or leases.

Agent names remain unique within the OS user.

## 2. Package and connection

The SDK is published as an explicit client-only entry point:

```ts
import {
  connectPiFleet,
  PiFleetError,
  type Agent,
  type AgentEvent,
  type ReceiveCursor,
} from "@elpapi42/pi-fleet/client";
```

Importing the SDK must not:

- Start the runtime.
- Start Pi.
- Register a service.
- Load SQLite or runtime internals.
- Change process-global state.

A client is created explicitly:

```ts
const client = await connectPiFleet();
```

`connectPiFleet()` returns a client façade, not an embedded runtime and not necessarily one permanent socket.

It owns:

- Runtime discovery and startup.
- Socket path selection.
- Private protocol framing.
- Protocol and capability negotiation.
- Runtime reconnection.
- External Pi identity checks for mutations.
- Mutation idempotency.
- Typed error translation.

Passive operations remain available when Pi is missing or incompatible. Pi is validated only before work-accepting operations such as create, send, or compact.

Advanced roots remain possible:

```ts
const client = await connectPiFleet({
  stateRoot: "/custom/state",
  applicationRoot: "/custom/application",
  autoStartRuntime: true,
});
```

Closing the client affects only local resources:

```ts
await client.close();
```

It closes that client's receive streams and transport connections. It does not stop pi-fleet or destroy agents.

## 3. Direct client API

The client uses direct methods. There is no `.agents` namespace because the SDK has one primary resource type and the extra namespace would add ceremony without resolving ambiguity.

```ts
interface PiFleetClient {
  create(input: CreateAgentInput): Promise<Agent>;
  get(name: string): Promise<Agent>;
  list(): Promise<readonly AgentSummary[]>;
  close(): Promise<void>;
}
```

The normal creation path is therefore:

```ts
const reviewer = await client.create({
  name: "reviewer",
  cwd: "/repo",
  piArgs: ["--session", "/sessions/reviewer.jsonl"],
});
```

The returned `Agent` is a local proxy to the shared remote agent.

```ts
interface Agent {
  readonly id: AgentId;
  readonly name: string;

  /**
   * Boundary after all output that existed when this agent
   * was created or imported.
   */
  readonly initialReceiveCursor: ReceiveCursor;

  send(message: string, options?: SendOptions): Promise<InputReceipt>;

  receive(options: ReceiveOptions): Promise<ReceiveStream>;

  status(options?: RequestOptions): Promise<AgentStatus>;

  compact(options?: CompactOptions): Promise<CompactionResult>;

  destroy(options?: DestroyOptions): Promise<void>;
}
```

Another client gets a proxy to the same shared agent:

```ts
const otherClient = await connectPiFleet();
const sameReviewer = await otherClient.get("reviewer");

await sameReviewer.send("Also inspect the tests.");
```

Agent objects carry the immutable agent ID as well as the name. A stale object must never operate on a later agent that reused the same name.

Listing returns the shared per-user agents:

```ts
const agents = await client.list();
```

Profiles remain entirely outside pi-fleet. A higher-level extension translates a profile into ordinary `cwd` and Pi launch arguments.

## 4. Agent creation is separate from initial work

The long-lived SDK creates an agent without implicitly sending instructions:

```ts
const reviewer = await client.create({
  name: "reviewer",
  cwd: "/repo",
  piArgs: [],
});
```

The caller can establish receive monitoring before sending anything:

```ts
const events = await reviewer.receive({
  after: reviewer.initialReceiveCursor,
});

await reviewer.send("Review the current changes.");
```

This avoids a create/receive race and keeps resource creation separate from communication.

One-time convenience APIs may compose create, receive, send, and destroy later.

## 5. Sending, steering, and follow-up

The default send mode is steering:

```ts
await reviewer.send("Prioritize correctness.");
```

Equivalent explicit form:

```ts
await reviewer.send("Prioritize correctness.", {
  delivery: "steer",
});
```

Pi follow-up behavior is also available:

```ts
await reviewer.send("After finishing, inspect the tests.", {
  delivery: "followUp",
});
```

```ts
interface SendOptions {
  readonly delivery?: "steer" | "followUp";
  readonly signal?: AbortSignal;
}
```

Semantics:

| Agent condition | `steer`                                        | `followUp`                                     |
| --------------- | ---------------------------------------------- | ---------------------------------------------- |
| Idle            | Ordinary prompt                                | Ordinary prompt                                |
| Active          | Delivered at Pi's next steering point          | Delivered after current work fully finishes    |
| Compacting      | Remains durably ordered until safe to dispatch | Remains durably ordered until safe to dispatch |

pi-fleet preserves Pi's steering and follow-up queues. It does not collapse them into one generic pending queue.

`send()` means only that input was durably accepted:

```ts
interface InputReceipt {
  readonly agent: {
    readonly id: AgentId;
    readonly name: string;
  };

  readonly inputId: InputId;
  readonly delivery: "steer" | "followUp";
  readonly acceptedAt: string;
}
```

It does not promise:

- One corresponding response.
- A response exclusively caused by this input.
- That steering interrupts a running tool.
- That the agent will produce visible assistant text.

Multiple sends may influence one eventual response.

### Hidden mutation idempotency

The SDK internally gives each mutation an idempotency identity.

This handles an ambiguous failure:

```text
runtime accepts send
→ response socket closes
→ SDK does not know whether acceptance occurred
```

Retrying with the same identity returns the original acceptance rather than delivering the instruction twice.

This remains hidden from ordinary users. A future advanced option may allow applications to persist an idempotency key across their own process restarts, but it is not part of the common API.

## 6. `receive` is the primary observation API

`receive` is a continuous, transformed, high-level event stream.

It is:

- Independent of agent `idle` or `working` state.
- Independent of sends.
- Passive: it never starts or restores Pi.
- Bound to the logical shared agent and native session, not one Pi process.
- Replayable using per-consumer cursors.
- Suitable for long-lived orchestration.

```ts
const events = await reviewer.receive({
  after: savedCursor,
});

for await (const event of events) {
  await processAgentEvent(event);
  await saveCursor(reviewer.id, event.cursor);
}
```

The promise resolves only after the runtime has atomically established the requested replay boundary and registered the logical-agent subscription. This does not require a live Pi process. An absent agent remains absent, and the subscription waits passively for later activity.

## 7. pi-fleet's high-level event standard

`receive` does not expose raw Pi RPC frames or fragmented deltas. It converts them into stable semantic events owned and versioned by pi-fleet.

Initial event family:

```ts
type AgentEvent =
  | AssistantMessageEvent
  | AssistantThinkingEvent
  | ToolExecutionEvent
  | CompactionEvent;
```

Turns are not part of the event model.

Generic retry events are not part of the initial event model.

### Common envelope

```ts
interface AgentEventBase {
  readonly schemaVersion: 1;
  readonly id: AgentEventId;

  readonly agent: {
    readonly id: AgentId;
    readonly name: string;
  };

  readonly session: {
    readonly id: string;
  };

  readonly observedAt: string;

  /**
   * Opaque per-agent replay position.
   */
  readonly cursor: ReceiveCursor;
}
```

No ordering is promised between different agents.

### Completed assistant messages

Pi text deltas are aggregated internally and emitted once:

```ts
interface AssistantMessageEvent extends AgentEventBase {
  readonly type: "assistant.message";
  readonly text: string;
}
```

The text is the completed visible assistant text, preserving its original content.

Thinking, tool calls, signatures, usage, and RPC metadata are excluded from this event.

An empty or whitespace-only assistant text produces no `assistant.message` event and no error.

### Completed thinking

Thinking deltas are aggregated into a completed event:

```ts
interface AssistantThinkingEvent extends AgentEventBase {
  readonly type: "assistant.thinking";
  readonly text: string;
}
```

pi-fleet exposes only thinking content Pi itself makes available. It does not attempt to decrypt or reconstruct unavailable reasoning.

### Completed tool executions

Tool start and end are collapsed into one event emitted only after execution finishes:

```ts
interface ToolExecutionEvent extends AgentEventBase {
  readonly type: "tool.execution";

  readonly tool: {
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly isError: boolean;
  };
}
```

A long-running tool produces no event until it completes. The event's common `observedAt` is the durable observation time; the initial API does not promise exact execution-start time or duration because those facts are not proven reconstructible from native session history.

If Pi or the runtime dies during execution, pi-fleet does not fabricate a tool result. The agent's failure remains available through `status()` and receive stream termination.

Tool inputs and outputs may contain sensitive data. The receive stream has the same OS-user trust boundary as the native Pi session.

### Compaction

A completed Pi compaction may produce:

```ts
interface CompactionEvent extends AgentEventBase {
  readonly type: "compaction";

  readonly reason: "manual" | "threshold" | "overflow" | "unknown";
  readonly outcome: "completed" | "aborted" | "failed";

  readonly tokensBefore?: number;
  readonly estimatedTokensAfter?: number;
}
```

Exact fields remain subject to validation against Pi's native compaction records. pi-fleet must not invent metrics Pi did not provide.

## 8. Empty assistant messages

An assistant entry containing thinking and `text: ""` is valid internal Pi activity.

Under the new receive model:

- Its completed thinking may produce `assistant.thinking`.
- It produces no `assistant.message`.
- It does not erase previous messages.
- It does not emit `no_response`.
- It does not close or interrupt receive.
- Later events continue normally.

The timer case becomes:

```text
assistant.thinking
tool.execution: timer
assistant.message: "⏱️ Timer set for 20s."

assistant.thinking: "Planning silent final response with timer"
(no assistant.message)

assistant.thinking
assistant.message: "STEERING APPLIED"
```

## 9. Retry-event decision

Pi 0.82.1 source was verified directly.

Pi emits agent-turn retry events on RPC stdout:

```text
auto_retry_start
auto_retry_end
```

It separately emits summarization retry events:

```text
summarization_retry_scheduled
summarization_retry_attempt_start
summarization_retry_finished
```

However:

- Provider HTTP retries can occur below Pi's session layer and remain invisible.
- Tool retries have no explicit Pi retry event.
- Repeated tool calls cannot safely be classified as retries.
- Pi retry lifecycle events are not automatically durable native-session entries.
- A generic `retry` event would combine materially different mechanisms.

Therefore, retries are omitted from the initial pi-fleet event standard.

Future additions must be precise, such as:

```text
agent.retry
summary.retry
```

They may be added only after pi-fleet can durably replay them and clearly documents that they represent Pi-reported retries rather than every retry in the provider/tool stack.

## 10. Receive boundaries and history

Every receive call selects an explicit starting boundary.

### Resume after a cursor

```ts
const events = await reviewer.receive({
  after: savedCursor,
});
```

Semantics:

1. Replay every retained high-level event strictly after the cursor.
2. Transition to live delivery without a gap.
3. Continue indefinitely until cancelled, destroyed, or terminally failed.

### Future events only

```ts
const events = await reviewer.receive({
  from: "now",
});
```

This atomically establishes a boundary and emits only later events.

### Full reconstructible history

```ts
const events = await reviewer.receive({
  from: "start",
});
```

This replays all supported high-level events that can be reconstructed from the native session as it currently exists, then continues live. The initial event family is limited to semantic records that the implementation spike proves reconstructible from durable native entries; live-only facts are not included in the public replay contract.

There is intentionally no ambiguous default.

```ts
type ReceiveOptions =
  | {
      readonly after: ReceiveCursor;
      readonly signal?: AbortSignal;
    }
  | {
      readonly from: "now" | "start";
      readonly signal?: AbortSignal;
    };
```

## 11. Cursor and delivery semantics

Cursors are:

- Opaque.
- Per agent.
- Bound to immutable agent ID.
- Bound to native session identity and generation.
- Invalid for a same-name replacement agent.
- Independent for every consumer.

pi-fleet does not prune or expire native session history on its own. A cursor remains valid while the immutable agent exists, the same native session identity remains selected, and the referenced native entry remains readable. Destroy invalidates the agent's cursors. User or Pi deletion, truncation, rewrite, replacement, or identity change may make a cursor unavailable; pi-fleet then fails visibly with `cursor_expired`, `session_unavailable`, `session_changed`, or `session_ambiguous` rather than guessing. `from: "start"` is intentionally unbounded by pi-fleet and means all supported events reconstructible from the native session as it currently exists.

Each SDK client or program stores its own cursor. pi-fleet does not maintain one global consumed position because several programs may independently receive from the same shared agent.

Delivery is at least once.

Possible recovery window:

```text
event delivered to consumer
→ consumer processes event
→ consumer crashes before storing cursor
→ event replays
```

Consumers deduplicate using the stable `event.id`.

Exactly-once delivery across independent processes is not claimed.

## 12. Receive lifecycle

A receive stream:

- Replays while the Pi process is absent.
- Waits passively for later explicit process restoration.
- Continues across ordinary Pi process incarnations when the same native session is proven.
- Does not consume global Pi process capacity.
- Does not wake an idle or absent agent.
- Uses bounded buffering.
- Never blocks Pi execution or another consumer.

A lagging consumer fails with a typed error containing its last safe cursor.

Terminal errors include:

```text
agent_destroyed
cursor_expired
subscriber_lagged
session_unavailable
session_changed
session_ambiguous
runtime_unavailable
protocol_incompatible
state_corrupt
```

Recoverable socket/runtime interruption may be retried internally. Semantic failures such as session replacement are never silently crossed.

Cancelling an `AbortSignal` ends only the local receive operation. It does not alter the agent.

## 13. Monitoring multiple agents

The initial SDK uses one lightweight asynchronous receive task per agent:

```ts
async function monitor(agent: Agent, cursor: ReceiveCursor) {
  try {
    const events = await agent.receive({ after: cursor });

    for await (const event of events) {
      await routeEventToMainAgent(event);
      await saveCursor(agent.id, event.cursor);
    }
  } catch (error) {
    await reportAgentStreamFailure(agent, error);
  }
}

await Promise.all([
  monitor(reviewer, reviewerCursor),
  monitor(securityReviewer, securityCursor),
  monitor(testReviewer, testReviewerCursor),
]);
```

These are JavaScript asynchronous tasks, not CLI subprocesses and not separate agents.

The SDK may initially use one private socket per receive stream. A future runtime may physically multiplex them over one socket without changing the public API.

A multi-agent monitor helper should be added only if dogfooding demonstrates repeated boilerplate or resource problems.

## 14. Removing `watch`

The next public version removes `watch` from:

- The CLI.
- The SDK.
- Public documentation.
- Public protocol capabilities.

The runtime may continue parsing Pi RPC internally, but raw RPC output is no longer a supported public surface.

If raw access is needed again later, it will be redesigned as a deliberate separate capability.

## 15. CLI projection

The CLI remains another access point to the same shared runtime.

Proposed command set:

```text
create
send
receive
status
list
compact
destroy
```

### Sending

Default steering:

```bash
pifleet send reviewer "Prioritize correctness."
```

Follow-up:

```bash
pifleet send reviewer "After finishing, inspect tests." --follow-up
```

### Receiving

Resume:

```bash
pifleet receive reviewer --after CURSOR
```

Future events only:

```bash
pifleet receive reviewer --from-now
```

Full history:

```bash
pifleet receive reviewer --from-start
```

CLI stdout contains the same `AgentEvent` JSONL objects as the SDK. Human formatting can remain an explicit option.

## 16. One-time use cases

One-time behavior is composed from the long-lived primitives:

```ts
const agent = await client.create({
  name: "temporary-reviewer",
  cwd: "/repo",
  piArgs: [],
});

const events = await agent.receive({
  after: agent.initialReceiveCursor,
});

await agent.send("Review this patch.");

for await (const event of events) {
  if (event.type === "assistant.message") {
    console.log(event.text);
    break;
  }
}

await agent.destroy();
```

A future helper may package this:

```ts
const result = await client.runOnce({
  name: "temporary-reviewer",
  cwd: "/repo",
  message: "Review this patch.",
  completion: "first-assistant-message",
  timeoutMs: 300_000,
});
```

This means “first completed visible assistant message after the established boundary.” It does not claim universal semantic task completion.

`runOnce()` is deferred until the continuous API has been dogfooded.

## 17. Public error model

Finite operations throw one stable error class:

```ts
try {
  await reviewer.send("Review this.");
} catch (error) {
  if (error instanceof PiFleetError) {
    console.error(error.code, error.message, error.details);
  }
}
```

```ts
class PiFleetError extends Error {
  readonly code: PiFleetErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}
```

Public errors contain safe structured details. Raw provider stderr and secret-bearing data must not be exposed through error messages.

Receive streams terminate by throwing `PiFleetError`.

## 18. Durable event source

The public SDK must not expose how replay is implemented.

The recommended implementation direction is:

- Native Pi sessions remain authoritative.
- pi-fleet never copies, relocates, rewrites, or deletes user-owned sessions.
- pi-fleet stores only event indexes, native entry identities, generations, sequences, hashes, and cursor metadata.
- pi-fleet does not impose a separate event-retention window or prune user-owned history.
- Replay reconstructs only high-level events proven derivable from durable entries in the exact native session.
- Live Pi events are correlated with durable native entries.
- Session rewrite, replacement, or identity ambiguity fails closed rather than guessing.

A copied semantic transcript inside SQLite is not the preferred direction because it would duplicate potentially sensitive session content and create retention and deletion obligations.

This recommendation must be proven before implementation. Pi sessions are trees and may be rewritten during some operations; byte offsets are therefore not safe cursors.

## 19. Clean beta cutover

This is an intentional breaking beta redesign. No backward-compatibility implementation is required.

The next version directly replaces the old public behavior:

- `receive` changes from finite idle-based latest-text retrieval to a continuous high-level event stream.
- `watch` is removed.
- `send` gains explicit follow-up semantics.
- New cursor and event contracts are introduced.
- The SDK becomes a public package surface.

There will be:

- No dual receive APIs.
- No deprecated compatibility mode.
- No old watch alias.
- No old/new CLI-runtime interoperability promise.
- No compatibility shim for prior SDK behavior because no public SDK exists yet.

The private protocol should receive a new major version so incompatible clients and runtimes fail explicitly instead of silently misinterpreting `receive`.

Native Pi sessions remain user-owned and must never be deleted or rewritten during the cutover.

If durable event indexing requires a SQLite schema change, the schema may advance directly. Older runtimes may refuse the new schema; binary downgrade is not presented as database rollback.

## 20. Deliberately excluded

The first SDK does not include:

- Profile management.
- Subordinate-specific reporting tools.
- Raw RPC watch.
- Turn events.
- Generic retry events.
- Tool-start events.
- Partial assistant or thinking deltas.
- Response-to-send correlation.
- Exactly-once delivery.
- Cross-agent global ordering.
- pi-fleet-owned consumer checkpoints.
- Public raw socket framing.
- Guaranteed one-socket multiplexing.
- Automatic semantic task-completion detection.
- Automatic service repair or runtime replacement.

## 21. Required proof before public release

The first implementation spike must prove:

1. Completed assistant and thinking deltas aggregate correctly.
2. Tool calls and results become one completed tool event.
3. Empty assistant text produces no error and does not interrupt receive.
4. Event IDs and per-agent cursors remain stable.
5. Replay after a cursor is ordered and duplicate-detectable.
6. Replay transitions to live delivery without gaps.
7. Multiple independent consumers can use different cursors.
8. A slow consumer never blocks Pi or another consumer.
9. A Pi crash during partial output does not fabricate completion.
10. Pi process restoration continues against the same session.
11. Runtime restart and SDK reconnect preserve completed event delivery.
12. Session replacement or rewrite fails visibly.
13. Destroy and same-name recreation reject stale handles and cursors.
14. SDK-created agents are immediately usable through another SDK client and the CLI.
15. CLI-created agents are immediately usable through the SDK.
16. Steering and follow-up preserve Pi's distinct semantics.
17. Twenty or more concurrent receive streams remain operationally bounded.
18. Packed and fresh-registry installs expose valid ESM imports and declarations.

The decisive dogfood scenario is a main-agent extension continuously managing several long-lived reviewer agents, receiving their high-level activity, steering or following up with them, surviving restarts, and reusing their native sessions across multiple assignments without CLI subprocesses or subordinate-specific reporting behavior.
