# @elpapi42/pi-fleet-cli

The `pif` command creates and discovers durable, host-local Pi agents.

```bash
npm install --global @elpapi42/pi-fleet-cli
```

```bash
pif create researcher --cwd "$PWD"
pif list
pif status researcher

# Pass a session selector directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl
pif create named --cwd "$PWD" -- --session-id my-session
```

Arguments after `--` pass through to Pi. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. Pi owns session lookup, working-directory selection, prompts, and failures.

Commands print human-readable output. Use `pif --help` or `pif COMMAND --help` for generated usage. By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. Pre-stable releases do not migrate state from earlier locations automatically. This CLI requires Node.js 22.12 or later. Slice 1 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, and `status`. Sending work, event streaming, recovery, retirement, compact, and destroy come in later slices.
