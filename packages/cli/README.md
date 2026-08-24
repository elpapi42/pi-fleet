# @elpapi42/pi-fleet-cli

The `pif` command creates and discovers durable, host-local Pi agents.

```bash
npm install --global @elpapi42/pi-fleet-cli
```

```bash
pif create researcher --cwd "$PWD"
pif list
pif status researcher

# Show durable activity from the current tail.
pif receive researcher

# In another terminal:
pif send researcher "Investigate the database schema"

# Replay all history, or resume after an SDK event cursor.
pif receive researcher --from-start
pif receive researcher --after pf1.EXAMPLE

# Show full bounded successful tool output and details.
pif receive researcher --verbose
pif send researcher "Summarize the findings" --follow-up

# Pass a session selector directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl
pif create named --cwd "$PWD" -- --session-id my-session
```

Arguments after `--` pass through to Pi. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. Pi owns session lookup, working-directory selection, prompts, and failures.

Commands print human-readable output. `pif send` confirms Pi accepted an instruction. It does not wait for the work to finish. During Pi or pre-dispatch worker recovery, it waits for restored Pi acknowledgement. It never retries a request that the old worker might have accepted. `pif receive` prints spaced Thinking, Assistant, Tool, and warning blocks without SDK cursor metadata. It reconnects after worker replacement and replays from its last delivered cursor internally. By default, successful tool output has an 8-line and 2 KiB preview. `--verbose` shows full bounded successful output and details. Failed tools show full bounded output and details. Use `--after` with an SDK event cursor to replay later events and continue live. Use `--from-start` to replay from the first event. A work-interrupted warning means an active Pi or worker runtime was lost, and the work may be incomplete. The CLI removes terminal control sequences, omits raw image data, and marks shortened or omitted values. Tool details can still contain sensitive local data. Press Ctrl-C to stop receiving. Use `pif --help` or `pif COMMAND --help` for generated usage.

Running agents keep the worker version used at creation. After updating pi-fleet, create a new agent before testing new worker behavior such as worker recovery. Until `destroy` exists, use a new agent name.

By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. Event history, including bounded tool details, remains there until destroy support arrives. There is no expiry or retention setting yet, so disk use can grow. Pre-stable releases do not migrate state from earlier locations automatically. This CLI requires Node.js 22.12 or later. Slice 6 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, `status`, `send`, durable `receive`, and transparent Pi and worker process recovery. Retirement, compact, and destroy come in later slices.
