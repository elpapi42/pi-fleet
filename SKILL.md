---
name: pi-fleet-operator
description: Operate the `pifleet` CLI for durable named Pi agents. Use this skill whenever the user asks to create or reuse a named agent, delegate or steer work through Pi Fleet, wait for or retrieve an agent response, inspect agent state, tail a Pi session, manage an existing Pi session through Fleet, or destroy a Fleet agent. Also use it for Pi Fleet CLI troubleshooting and automation, even when the user says only “the fleet,” “my named agent,” or “send this to the specialist.”
compatibility: Requires the `pifleet` executable on PATH and a supported Pi Fleet installation.
---

# Pi Fleet operator

Use Pi Fleet as a small lifecycle layer around native Pi sessions. Preserve the distinction between a durable Fleet name, a resident or absent Pi process, and the user-owned Pi session.

## Establish context

1. Confirm the executable and version before the first operation:

   ```bash
   command -v pifleet
   pifleet --version
   ```

2. Do not install, upgrade, repair, or restart Pi Fleet unless the user asks for maintenance. Ordinary agent operations should use the existing installation.
3. Prefer the default compact JSON output for automation. Use `--human` only when presenting a response directly to a person.
4. Treat stdout, stderr, and exit status as separate contracts. Do not scrape human prose when JSON is available.

Operational commands may start the central Fleet runtime, but passive inspection must not wake an individual agent. `status`, `list`, `watch`, and retrieval of an already settled response are passive with respect to the Pi process.

## Create an agent

Use an explicit, stable lowercase name. Valid names are 1–63 characters matching:

```text
^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

Create a promptless agent when the user has not supplied work:

```bash
pifleet create NAME --cwd /absolute/project/path
```

Create and immediately assign work when instructions are already known:

```bash
pifleet create NAME "INITIAL INSTRUCTIONS" --cwd /absolute/project/path
```

`--cwd` is a Fleet option and belongs before the first literal `--`. Put native Pi options after that boundary, preserving their tokens and order:

```bash
pifleet create NAME \
  --cwd /absolute/project/path \
  -- \
  --model anthropic/claude-sonnet-4 \
  --thinking high
```

Pi sessions are user-controlled resources. To use an existing or explicitly selected native session, pass Pi's selector after `--`:

```bash
pifleet create NAME --cwd /absolute/project/path -- --session /absolute/session.jsonl
pifleet create NAME --cwd /absolute/project/path -- --session-id SESSION_ID
pifleet create NAME --cwd /absolute/project/path -- --fork /absolute/source.jsonl
pifleet create NAME --cwd /absolute/project/path -- --continue
```

Fleet reopens the concrete selected session during restoration. It does not copy, relocate, or delete the session.

## Send and receive work

Send ordinary Pi input with one stable verb:

```bash
pifleet send NAME "MESSAGE"
```

A successful send means Fleet accepted and ordered the input. It does not mean the work completed or produced a distinct response. While Pi is active, later sends steer the active work at Pi's next decision point; while idle, a send begins normal work.

Wait for the agent to become idle and retrieve Pi's latest assistant message:

```bash
pifleet receive NAME --timeout 10m
```

For direct human display:

```bash
pifleet receive NAME --timeout 10m --human
```

Important receive semantics:

- The result is non-consuming and may be retrieved repeatedly.
- It is Pi's latest assistant text, not a response correlated to one particular send.
- Multiple sends may influence one final response.
- `--timeout 0` performs an immediate poll.
- Use explicit units such as `30s`, `5m`, or `1h`; a unitless duration is milliseconds.
- Timeout exits with status `124` and does not cancel or alter agent work.
- Canceling a held receive affects only that client.

When sending large or shell-sensitive content, use explicit stdin. Fleet never consumes piped stdin implicitly:

```bash
git diff | pifleet send NAME -
pifleet create NAME - --cwd /absolute/project/path < instructions.md
```

The default message limit is 512 KiB. Input must be valid UTF-8 and not empty or whitespace-only. Never place API keys or credentials in messages or Pi arguments merely to configure the process; accepted Pi arguments are persisted for restoration, and an already-running Fleet runtime does not inherit environment variables added only to a later CLI invocation.

## Inspect without changing work

Inspect one agent:

```bash
pifleet status NAME
```

List all logical agents:

```bash
pifleet list
```

Reason from both logical state and process residency. An `idle` agent can be `resident` or `absent`; the next send restores an absent agent from its native session. Do not infer continuity from a PID.

If an agent is `failed`, inspect its error before acting. In particular:

- `runtime_interrupted` means active work was interrupted and was not silently replayed.
- `delivery_uncertain` means Pi may have received the input; do not automatically resend because tools may already have produced side effects.
- `incarnation_cleanup_uncertain` means Fleet cannot prove an old process writer is gone; do not force a second writer.
- `session_unavailable` or `session_ambiguous` means continuity cannot safely be claimed.

Ask the user before retrying semantically uncertain work. A new explicit send is a new instruction, not proof that the old one did nothing.

## Watch native session records

`watch` is a live, byte-faithful tail of complete LF-terminated records from the selected Pi session JSONL:

```bash
pifleet watch NAME
```

It has no `--human` mode and adds no Fleet wrappers, readiness markers, history, or transient RPC events. For an existing session it begins at the current EOF; for an unmaterialized session it waits and begins at byte zero when the file appears.

Keep watching decoupled from sending. Starting or canceling a watcher must not wake, steer, cancel, or otherwise change the agent. Treat replacement, truncation, path changes, lag, runtime loss, or unexpected EOF as visible watch failures rather than guessing or replaying bytes.

## Destroy deliberately

Destroy only when the user wants Fleet to stop managing the named agent:

```bash
pifleet destroy NAME
```

Destroy stops the managed process and removes Fleet's name, operation state, and capacity ownership. It never deletes the Pi session, Pi configuration, credentials, extensions, skills, prompts, or project files.

Do not automatically destroy a durable collaborator merely because one assignment finished. For clearly temporary agents, destroy after confirming the required result or artifact was received.

## Automation and error handling

Finite commands emit one compact JSON object on success. Failures emit one structured JSON error object on stderr and normally exit `1`; receive timeout exits `124`. `watch` emits only native session JSONL to stdout and diagnostics to stderr.

For scripts:

- preserve the command's exit status;
- parse finite-command JSON rather than matching prose;
- keep `watch` stdout untouched if byte fidelity matters;
- handle a closed downstream watch pipe as normal client disconnection;
- avoid concurrent commands that assume send-to-response correlation;
- use the same agent name for related follow-up work when retained session context is the desired benefit.

## Safe testing boundary

Never test against the user's default Fleet state unless the user explicitly asks to exercise real agents. Isolate experimental or destructive checks with dedicated temporary values for at least:

```text
HOME
XDG_RUNTIME_DIR
PIFLEET_STATE_ROOT
PIFLEET_APPLICATION_ROOT
PI_CODING_AGENT_DIR
PIFLEET_DISABLE_REGISTERED_SERVICE=1
```

Use unique temporary roots and clean up only resources created under those roots. Do not operate on unrelated real Fleet agents, sessions, services, or process groups.

## Report completion

Report the agent name, the operation performed, the resulting logical/process state when relevant, and the retrieved response or artifact. Call out timeout, uncertainty, interruption, or unvalidated continuity explicitly. Keep routine reports concise and never expose private session content, credentials, or unnecessary paths.
