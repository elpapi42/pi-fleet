---
name: pi-fleet-operator
description: Use `pifleet` as a machine-first control layer for Pi processes and sessions. Invoke this skill whenever an agent, Pi extension, orchestration workflow, or AI factory needs to provision Pi execution, delegate or steer work, inspect lifecycle state, retrieve exact latest settled assistant text, consume native session JSONL, restore a session-backed process, coordinate several Pi workers, or release pi-fleet management. Also use it for pi-fleet automation and troubleshooting even when the user says only “use pi-fleet,” “delegate this,” “ask the reviewer,” or “check the workers.”
compatibility: Requires the `pifleet` executable on PATH and a supported pi-fleet installation.
---

# pi-fleet operator

Use pi-fleet as Pi-native execution infrastructure, not as a terminal multiplexer or workflow engine. pi-fleet owns process lifecycle, ordered communication, restoration, and exact result retrieval. The calling agent owns task decomposition, roles, scheduling, semantic retries, aggregation, observability, and knowledge mining.

The governing boundary is: **pi-fleet controls execution; the user controls the session.**

## Establish context safely

1. Confirm the executable and version before the first operation:

   ```bash
   command -v pifleet
   pifleet --version
   ```

2. Do not install, upgrade, repair, or restart pi-fleet unless the user asks for maintenance.
3. Use the default compact JSON output for every finite command. Capture stdout, stderr, and exit status separately, and parse JSON rather than matching prose.
4. Do not use `--human` for orchestration. If a person needs a result, parse the machine response and present the relevant information yourself.
5. Treat `watch` differently from finite commands: its stdout is native Pi session JSONL, not pi-fleet response JSON.

Operational commands may start the central runtime. Passive inspection must not wake an individual Pi process: `status`, `list`, `watch`, and retrieval of an already settled response remain passive with respect to Pi.

## Choose whether to reuse or provision

Start with `list` or `status` when continuity may already exist:

```bash
pifleet list
pifleet status NAME
```

Reuse an existing entry when the assignment should benefit from its native Pi session. Provision a new entry only when a distinct execution resource or conversation is intended.

Names are stable local programmatic addresses, not personas or workflow definitions. Use deterministic, collision-safe lowercase names of 1–63 characters matching:

```text
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

Provision without initial work:

```bash
pifleet create NAME --cwd /absolute/project/path
```

Provision and submit initial work:

```bash
pifleet create NAME "INITIAL INSTRUCTIONS" --cwd /absolute/project/path
```

`--cwd` belongs to pi-fleet and must appear before the first literal `--`. Preserve every native Pi option after that boundary in its original token order:

```bash
pifleet create NAME \
  --cwd /absolute/project/path \
  -- \
  --model anthropic/claude-sonnet-4 \
  --thinking high
```

## Preserve user control of sessions

Pi sessions are user-controlled native resources. Use exact selectors when supplied:

```bash
pifleet create NAME --cwd /absolute/project/path -- --session /absolute/session.jsonl
pifleet create NAME --cwd /absolute/project/path -- --session-id SESSION_ID
pifleet create NAME --cwd /absolute/project/path -- --fork /absolute/source.jsonl
pifleet create NAME --cwd /absolute/project/path -- --continue
```

pi-fleet records the concrete selected session for restoration and observation. It never copies, relocates, normalizes, or deletes the session.

Do not hide, replace, or take ownership of session files in orchestration code. External observability and knowledge-mining systems should consume the native files or `watch` stream directly. Deliberate concurrent writers are allowed at the user's risk; never imply that arbitrary concurrent mutation preserves restoration or live-tail correctness.

## Submit and steer work

Send ordinary Pi input through one verb:

```bash
pifleet send NAME "MESSAGE"
```

A successful send means pi-fleet accepted and ordered the input. It does not mean Pi completed the work or produced a distinct response.

- While Pi is idle, `send` starts ordinary work.
- While Pi is active, `send` uses Pi's steering behavior at its next decision point.
- Repeated sends remain ordered and may influence one settled result.
- pi-fleet deliberately does not provide one-send/one-response attribution.

For large or shell-sensitive input, request stdin explicitly with `-`. pi-fleet never consumes piped stdin implicitly:

```bash
git diff | pifleet send NAME -
pifleet create NAME - --cwd /absolute/project/path < instructions.md
```

Input must be nonempty valid UTF-8 and is limited to 512 KiB by default. Never place API keys or credentials in persisted messages or Pi arguments merely to configure the runtime. A persistent runtime does not inherit environment variables added only to a later CLI invocation.

## Retrieve the semantic result

Wait for Pi to become idle and retrieve its exact latest assistant text:

```bash
pifleet receive NAME --timeout 10m
```

Parse the JSON result. Do not approximate the response from `watch`, logs, stderr, terminal output, or last-line heuristics.

Receive semantics:

- The result is non-consuming and can be retrieved repeatedly.
- It is the latest assistant text, not a response correlated to one send.
- Several sends may influence the returned response.
- `--timeout 0` performs an immediate poll.
- Use explicit units such as `30s`, `5m`, or `1h`; unitless values are milliseconds.
- Timeout exits `124` without canceling or mutating Pi work.
- Canceling one held receive affects only that client.

The calling agent is responsible for mapping assignments to entries and deciding how to aggregate returned results.

## Inspect lifecycle state

Use machine-readable inspection rather than inferring state from output:

```bash
pifleet status NAME
pifleet list
```

Reason separately about logical state and process residency. An `idle` entry can be `resident` or `absent`; the next send restores an absent process from its native session when safe. Never infer continuity from a PID.

Handle failed state conservatively:

- `runtime_interrupted`: active work stopped and was not silently replayed.
- `delivery_uncertain`: Pi may have received the input; automatic replay could duplicate tool side effects.
- `incarnation_cleanup_uncertain`: pi-fleet cannot prove an old process writer is gone; do not force a replacement writer.
- `session_unavailable` or `session_ambiguous`: continuity cannot safely be claimed.

Ask for policy or user direction before semantically retrying uncertain work. A new send is a new instruction, not evidence that earlier work did nothing.

## Coordinate multiple entries

When orchestrating several Pi processes:

1. Keep fan-out bounded by available capacity.
2. Give each intended continuity boundary its own deterministic name and session.
3. Treat lifecycle, timeout, and failure independently per entry.
4. Do not assume completion order matches submission order.
5. Retrieve each entry's exact latest settled assistant text with `receive`; do not mine terminal-like output for answers.
6. Aggregate, compare, route, and validate results in the calling layer.
7. Keep semantic retry and cancellation policy outside pi-fleet.

pi-fleet has no scheduler queue or idle-process eviction. A process-starting operation can return `capacity_exceeded`; callers must reduce fan-out or deliberately release another entry rather than assuming hidden queueing.

## Consume native session records

`watch` is a live, byte-faithful tail of complete LF-terminated records from the persistent Pi session JSONL:

```bash
pifleet watch NAME
```

Use it as an input to custom observability, indexing, auditing, debugging, or knowledge-mining systems. It is not terminal output and not a public stream of transient Pi RPC traffic.

`watch` emits no pi-fleet wrappers, lifecycle records, readiness markers, or history. For an existing session it begins at the current EOF; for an unmaterialized session it waits and begins at byte zero when the file appears.

Keep watching decoupled from sending. Starting or canceling a watcher must not wake, steer, cancel, or otherwise change Pi. Treat replacement, truncation, path changes, lag, runtime loss, or unexpected EOF as visible failures rather than guessing or replaying bytes.

Use `status` and `list` for lifecycle information. Never infer lifecycle solely from session records.

## Release management deliberately

Release an entry only when pi-fleet should stop owning its process lifecycle:

```bash
pifleet destroy NAME
```

Destroy stops the managed process and removes pi-fleet's name, operation state, and capacity ownership. It never deletes Pi sessions, configuration, credentials, extensions, skills, prompts, or project files.

Do not automatically destroy a reusable entry merely because one assignment finished. For intentionally temporary entries, retrieve the required result or artifact before releasing management.

## Respect transport contracts

Finite commands emit one compact JSON object on stdout when successful. Expected failures emit one structured JSON error object on stderr. Preserve exit status:

- `0`: success;
- `1`: error;
- `124`: receive timeout.

For automation:

- parse finite-command JSON rather than matching prose;
- never mix stderr diagnostics into stdout data;
- keep `watch` bytes untouched when fidelity matters;
- treat downstream `watch` EPIPE as normal client disconnection;
- avoid concurrency assumptions based on send-to-response correlation;
- use the same entry for related work only when retained session context is intentional.

## Isolate testing

Never test against the user's default pi-fleet state unless explicitly asked to exercise real entries. Isolate experimental or destructive checks with unique temporary values for at least:

```text
HOME
XDG_RUNTIME_DIR
PIFLEET_STATE_ROOT
PIFLEET_APPLICATION_ROOT
PI_CODING_AGENT_DIR
PIFLEET_DISABLE_REGISTERED_SERVICE=1
```

Clean up only resources created under those roots. Do not operate on unrelated pi-fleet entries, sessions, services, or process groups.

## Report outcomes

Report the pi-fleet name, operation, resulting lifecycle/residency state when relevant, and the parsed response or artifact. Surface timeout, interruption, uncertainty, and unvalidated continuity explicitly. Never expose credentials, private session contents, or unnecessary paths.
