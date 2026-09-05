# @elpapi42/pi-fleet-cli

The `pif` command creates and discovers durable, host-local Pi agents.

```bash
npm install --global @elpapi42/pi-fleet-cli
```

```bash
pif create researcher --cwd /home/user/project
pif list
pif status researcher

# Show durable activity from the current tail.
pif receive researcher

# In another terminal:
pif send researcher "Investigate the database schema"

# Replay all durable activity.
pif receive researcher --from-start

# Show full bounded successful tool output and details.
pif receive researcher --verbose
pif send researcher "Summarize the findings" --follow-up

# Stop active work and delete the agent with its complete history.
pif destroy researcher

# Pass a session selector directly to Pi
pif create existing --cwd /home/user/project -- --session /path/to/session.jsonl
pif create named --cwd /home/user/project -- --session-id my-session

# Select a Pi profile for this durable agent before Pi arguments.
pif create profiled --cwd /home/user/project --agent-dir /home/user/pi-profiles/profiled -- --session /path/to/session.jsonl

# Select a separate pi-fleet environment for every command.
pif --state-dir /tmp/team-fleet create analyst --cwd /home/user/project -- --session /tmp/analyst.jsonl
pif --state-dir /tmp/team-fleet list
pif --state-dir /tmp/team-fleet status analyst
pif --state-dir /tmp/team-fleet send analyst "Continue"
pif --state-dir /tmp/team-fleet receive analyst --from-start
pif --state-dir /tmp/team-fleet destroy analyst
```

Use the optional global `--state-dir PATH` before the command to select another pi-fleet environment. Commander also accepts it after a subcommand, such as `pif list --state-dir /tmp/team-fleet`. Relative paths resolve from the CLI process current directory. Put `--state-dir` before create's `--` separator because arguments after that separator pass through to Pi. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. Pi owns session lookup, working-directory selection, prompts, and failures. Caller-owned Pi session selectors remain unchanged and authoritative. For fleet-owned sessions, pi-fleet restores an existing physical session by its exact path. If Pi reported a session path and ID but has not materialized the file, pi-fleet restarts with the persisted session ID and still requires Pi to report that exact ID.

`pif create --agent-dir PATH` selects Pi's profile directory for that agent. It must be before create's `--` separator. It differs from the agent `--cwd` and global pi-fleet `--state-dir`. A supplied path resolves from the CLI process current directory, persists with the agent, and reaches each Pi child as `PI_CODING_AGENT_DIR` during initial startup, Pi recovery, and worker recovery. Omission preserves today's inherited Pi environment behavior. Users own profile creation, contents, credentials, permissions, sharing, and errors. Pi determines credential precedence. The selected profile can provide credentials, and provider credentials inherited from the process environment remain available to Pi. Pi-fleet does not copy or delete profile data, alter trust, or create a sandbox. Project `.pi` resources and project or ancestor `AGENTS.md` remain Pi-owned behavior.

Commands print human-readable output. `pif send` confirms Pi accepted an instruction. It does not wait for the work to finish. During Pi or pre-dispatch worker recovery, it waits for restored Pi acknowledgement. It never retries a request that the old worker might have accepted. `pif receive` supports live-only activity, `--from-start` replay, and `--verbose` output. It prints spaced Thinking, Assistant, Tool, and Agent destroyed blocks without SDK cursor metadata. It reconnects after worker replacement and replays from its last delivered cursor internally. By default, successful tool output has an 8-line and 2 KiB preview. `--verbose` shows full bounded successful output and details. Failed tools show full bounded output and details. Plain `pif receive NAME` is live-only and can miss activity before subscription acknowledgement. Use `pif receive NAME --from-start` before sending work when the first activity must not be missed. Exact cursor resume remains available through the SDK, not through the CLI. Check `pif status NAME` for sticky `interrupted` after active Pi runtime loss. The state remains interrupted until Pi starts newly sent work. `pif list` is inventory and can temporarily show stale working state after an unobserved worker loss. Pi owns normal tool failures and live model or tool stalls. The CLI removes terminal control sequences, omits raw image data, and marks shortened or omitted values. Tool details can still contain sensitive local data. Press Ctrl-C to stop receiving. Use `pif --help` or `pif COMMAND --help` for generated usage.

`pif destroy NAME` requires no confirmation. It can stop active work, prints completion after durable cleanup, and removes the worker, Pi, IPC socket, agent name, record, and complete event history. The same name can then create a new agent with a new ID.

Running agents keep the worker version used at creation. After updating pi-fleet, create a new agent before testing new worker behavior such as worker recovery. CLI `0.16.2` uses SDK `0.12.2`, which removes `work.interrupted` from replay. Destroy and recreate agents made by older versions before using this release.

By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. `--state-dir PATH` selects another environment. Event history, including bounded tool details, remains there until the owner runs `pif destroy NAME`. There is no expiry or retention setting yet, so disk use can grow. Pre-stable releases do not migrate state from earlier locations automatically. This CLI requires Node.js 22.12 or later. Slice 8 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, `status`, `send`, durable `receive`, `destroy`, and transparent Pi and worker process recovery. Runtime retirement and compaction are outside the initial product.
