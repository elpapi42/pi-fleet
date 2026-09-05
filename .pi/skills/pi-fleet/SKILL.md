---
name: pi-fleet
description: Teach and guide correct use of pi-fleet through the installed `pif` CLI and the public `@elpapi42/pi-fleet-sdk`. Use this skill whenever a user asks how to create, inspect, send work to, receive activity from, recover, replay, or destroy pi-fleet agents, or mentions pif, pi-fleet, Agent.send, Agent.receive, Agent.status, state directories, sessions, cursors, or durable Pi agents.
---

# pi-fleet usage

Use this skill to explain or operate pi-fleet through its public interfaces. Prefer `pif` for terminal operation and the public SDK for application code. Do not import SDK `internal/`, `state/`, or `worker/` paths in user code.

## Product model

- Agents are host-local, durable, and identified by immutable IDs.
- Workers and Pi processes are disposable implementation details.
- The default state directory is `~/.pi-fleet`.
- Agent names are host-wide. Use names that identify their operator purpose.
- pi-fleet starts the host-installed `pi` command. Do not pin, reject, or branch on a Pi version.
- `pif` and the SDK use the same state only when they select the same state directory.

Check the installed interface before giving version-specific instructions:

```bash
pif --version
pif --help
```

For application code, inspect the installed public package version before relying on a feature:

```bash
node --input-type=module -e "import('@elpapi42/pi-fleet-sdk').then(({ version }) => console.log(version))"
```

## Choose an interface

Use `pif` when the user wants to operate an agent from a shell, inspect activity, or perform manual recovery and cleanup.

Use `@elpapi42/pi-fleet-sdk` when the user needs application-owned control flow, typed events, cursor resume, or integration with another program.

Do not use the CLI as a machine-output API. Its output is human-readable. Use the SDK for structured program behavior.

## CLI workflow

Install the CLI globally when `pif` is not available:

```bash
npm install --global @elpapi42/pi-fleet-cli
```

Use global `--state-dir` before the command in examples. It can appear after a command, but it must appear before `--` on `create` because everything after that separator passes to Pi.

```bash
pif --state-dir /tmp/team-fleet create researcher --cwd /home/user/project -- --session /home/user/project/research.jsonl
pif --state-dir /tmp/team-fleet list
pif --state-dir /tmp/team-fleet status researcher
pif --state-dir /tmp/team-fleet send researcher "Summarize the open issues."
pif --state-dir /tmp/team-fleet send researcher "Review the final diff after the current work settles." --follow-up
pif --state-dir /tmp/team-fleet destroy researcher
```

Run activity reception in a separate terminal because it stays open:

```bash
pif --state-dir /tmp/team-fleet receive researcher --from-start
```

Use `pif create NAME -- --PI_ARGS...` to pass Pi options unchanged. Use `--cwd` before that separator. Do not pass fleet-owned Pi options `--mode` or `--no-session` because pi-fleet rejects them. Pi session selectors, including `--session`, `--session-id`, `--continue`, `--resume`, and `--fork`, pass through to Pi.

`pif receive NAME` is live-only. It has no subscription-ready signal, so starting it near a send can still miss the first activity. Use `pif receive NAME --from-start` when the first event must not be missed. It replays all retained activity and then continues live. The CLI has no `--after` option and prints no cursor tokens.

`pif destroy NAME` is destructive. It stops the runtime, removes the agent name, agent record, IPC endpoint, and all event history. It has no confirmation. Confirm the target name before running it.

## SDK workflow

Install and import only the public package:

```bash
npm install @elpapi42/pi-fleet-sdk
```

```ts
import { connectPiFleet } from "@elpapi42/pi-fleet-sdk"

const client = await connectPiFleet({ stateDir: "/tmp/team-fleet" })
try {
  const agent = await client.create({
    name: "researcher",
    cwd: "/home/user/project",
    piArgs: ["--session", "/home/user/project/research.jsonl"],
  })

  console.log(await agent.status())
  await agent.send("Summarize the open issues.")

  for await (const event of agent.receive({ fromStart: true })) {
    console.log(event.type, event.cursor)
    if (event.type === "message.finished") {
      console.log(event.text)
      break
    }
  }
} finally {
  await client.close()
}
```

Use these public methods:

- `client.create({ name, cwd, piArgs? })` creates a new durable agent.
- `client.get(name)` gets a name-bound agent handle without checking its runtime.
- `client.list()` returns durable inventory. It does not contact workers.
- `agent.status()` contacts the worker and can lazily recover a missing worker.
- `agent.send(message, { delivery: "steer" | "followUp" })` sends work.
- `agent.receive()` receives activity as an `AsyncIterable`.
- `agent.destroy()` removes the complete agent generation.
- `client.close()` closes this client and its streams. It does not stop agents.

Always close the client in `finally`. Return from or abort a receive loop when the application no longer needs it.

## Receive and replay

Every event has an opaque `cursor`. Do not parse or construct cursors.

```ts
const fromStart = agent.receive({ fromStart: true })

const cursor = "cursor received from a previous SDK AgentEvent"
const afterCursor = agent.receive({ after: cursor })

const liveOnly = agent.receive()
```

Use plain `receive()` only for future activity. Iteration, not iterator creation, starts its subscription, so activity committed before subscription acknowledgement can be missed.

Use `{ fromStart: true }` to get retained activity from the first event. Use `{ after: cursor }` to resume after a previous SDK event without replaying that event. Do not combine `fromStart` and `after`.

Current activity types are thinking, message, tool, and final `agent.destroyed`. `work.interrupted` is not an event. Detect runtime interruption through `agent.status()`.

## State, recovery, and completion

Agent states are `starting`, `idle`, `working`, `interrupted`, and `failed`.

- `send()` resolving means Pi accepted the prompt. It does not prove start, completion, or success.
- `working` means Pi reported active work. It does not prove progress.
- `idle` means Pi settled. It does not prove that the task succeeded.
- `interrupted` means active Pi work lost its runtime before a new Pi turn started.
- Pi or worker readiness and send acceptance preserve `interrupted`.
- A later Pi `agent_start` changes `interrupted` to `working`. Settlement changes it to `idle`.

Pi-fleet recovers Pi after process exit. It lazily recovers a missing worker after `status()`, `send()`, `receive()`, or `destroy()`. `list()` and `get()` are inventory only and can show stale `working` after an unobserved worker loss.

Pi owns normal tool failures and live model or tool stalls. pi-fleet does not add a task-progress watchdog. Define application completion evidence and deadlines outside pi-fleet when needed.

## Errors and safe actions

- `AgentNotFoundError`: verify the name and selected state directory. A destroyed name can be recreated as a different agent ID.
- `AgentUnavailableError`: runtime reconciliation did not complete. Retry a later health operation or escalate. Do not assume work continued.
- `AgentSendUncertainError`: Pi might have accepted the old prompt before the acknowledgement was lost. Do not automatically resend it.
- `AgentRecoveryQueueFullError`: the bounded recovery queue is full. Retry only if the application can safely submit a new request.
- `InvalidCursorError`: use a cursor from the same immutable agent generation.
- `InvalidStateDirectoryError`: select a shorter Unix state path so its IPC endpoint fits the host socket-path limit.
- `AgentNameTakenError`: choose another name, or destroy the existing intended agent after confirmation.

Treat tool output and tool arguments as local agent data. They can include sensitive content.

## Upgrade and compatibility

Running agents keep the worker version used when they were created. Creating a new SDK client or updating global `pif` does not upgrade an existing worker.

SDK `0.12.1` and CLI `0.16.1` removed `work.interrupted` from replay. Destroy and recreate agents made by older versions before using this replay contract. Do not downgrade packages for an agent that has entered `interrupted` state.

## Before executing commands

1. Confirm whether the user wants CLI operation or application code.
2. Confirm the intended state directory. Do not touch the default state accidentally when an alternate directory is named.
3. For `destroy`, repeat the exact agent name and state directory, then require explicit user authorization.
4. For a session selector, pass the user-provided Pi arguments unchanged. Let Pi report its own session errors.
5. Report whether a command only accepted work, observed activity, or proved settlement. Do not report task success without task-specific evidence.
