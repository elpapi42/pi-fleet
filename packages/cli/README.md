# @elpapi42/pi-fleet-cli

The `pif` command creates and discovers durable, host-local Pi agents.

```bash
npm install --global @elpapi42/pi-fleet-cli
```

```bash
pif create researcher --cwd "$PWD"
pif send researcher "Investigate the database schema"
pif send researcher "Summarize the findings" --follow-up
pif receive researcher
pif list
pif status researcher

# Pass a session selector directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl
pif create named --cwd "$PWD" -- --session-id my-session
```

Arguments after `--` pass through to Pi. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. Pi owns session lookup, working-directory selection, prompts, and failures.

Commands print human-readable output. `pif send` confirms Pi accepted or queued an instruction. It does not wait for the work to finish. `pif receive` shows best-effort live activity after it subscribes. Press Ctrl-C to stop receiving. Missed events cannot replay until Slice 4. Use `pif --help` or `pif COMMAND --help` for generated usage. By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. Pre-stable releases do not migrate state from earlier locations automatically. This CLI requires Node.js 22.12 or later. Slice 3 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, `status`, `send`, and `receive`. Recovery, durable replay, retirement, compact, and destroy come in later slices.
