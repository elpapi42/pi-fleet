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

# Replay all history, or resume after a printed cursor.
pif receive researcher --from-start
pif receive researcher --after pf1.EXAMPLE
pif send researcher "Summarize the findings" --follow-up

# Pass a session selector directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl
pif create named --cwd "$PWD" -- --session-id my-session
```

Arguments after `--` pass through to Pi. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. Pi owns session lookup, working-directory selection, prompts, and failures.

Commands print human-readable output. `pif send` confirms Pi accepted an instruction. It does not wait for the work to finish. During Pi recovery, it waits for restored Pi acknowledgement. `pif receive` prints durable activity and an opaque `Cursor:` line after every event. Copy a cursor into `--after` to replay later events and continue live. Use `--from-start` to replay from the first event. `Work interrupted.` means Pi exited during active work. The work may be incomplete, and the user decides whether to send a continuation. It shows model-requested tool parameters and bounded final tool output. It removes terminal control sequences, omits raw image data, and marks shortened or omitted values. Tool details can still contain sensitive local data. Press Ctrl-C to stop receiving. Use `pif --help` or `pif COMMAND --help` for generated usage.

Running agents keep the worker version used at creation. After updating pi-fleet, create a new agent before testing new worker behavior such as live receive. Until `destroy` exists, use a new agent name.

By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. Event history, including bounded tool details, remains there until destroy support arrives. There is no expiry or retention setting yet, so disk use can grow. Pre-stable releases do not migrate state from earlier locations automatically. This CLI requires Node.js 22.12 or later. Slice 4 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, `status`, `send`, durable `receive`, and transparent Pi process recovery. Worker recovery, retirement, compact, and destroy come in later slices.
