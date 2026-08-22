# @elpapi42/pi-fleet-cli

The `pif` command creates and discovers durable, host-local Pi agents.

```bash
npm install --global @elpapi42/pi-fleet-cli
```

```bash
pif create researcher --cwd "$PWD"
pif list
pif status researcher
```

Commands emit compact JSONL. Slice 1 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides `create`, `list`, and `status`. Sending work, event streaming, recovery, retirement, compact, and destroy come in later slices.
