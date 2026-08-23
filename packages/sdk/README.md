# @elpapi42/pi-fleet-sdk

Create and discover durable, host-local Pi agents.

```bash
npm install @elpapi42/pi-fleet-sdk
```

```ts
import { connectPiFleet } from "@elpapi42/pi-fleet-sdk"

const client = await connectPiFleet()
const agent = await client.create({
  name: "researcher",
  cwd: process.cwd(),
})

await agent.send("Investigate the database schema")
console.log(await agent.status())
await client.close()
```

`piArgs` passes Pi options through unchanged. Pi-fleet adds `--mode rpc` and rejects `--mode` and `--no-session`. User session selectors remain authoritative:

```ts
await client.create({
  name: "existing-session",
  cwd: process.cwd(),
  piArgs: ["--session", "/path/to/session.jsonl"],
})
```

Pi owns session lookup, working-directory selection, prompts, and failures. If the user supplies no session selector, Pi-fleet uses the observed session path for later Pi recovery.

By default, pi-fleet stores its LMDB environment and worker IPC sockets in `~/.pi-fleet`. Pre-stable releases do not migrate state from earlier locations automatically. Pass `stateDir` to `connectPiFleet` only when you need an explicit location, such as an isolated test or an advanced local setup:

```ts
const client = await connectPiFleet({ stateDir: "/path/to/pi-fleet-state" })
```

`client.get(name)` and `client.list()` discover agents created by another local client. `client.close()` only closes this SDK client. It does not stop an agent worker.

`agent.send(message)` starts work when Pi is idle. During active work, it uses `steer` by default. Use `followUp` to deliver after the current work settles:

```ts
await agent.send("Summarize the findings", { delivery: "followUp" })
```

`send()` resolves after Pi accepts or queues the instruction. It does not wait for completion. Slice 2 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides create, get, list, status, and send. Event streaming, recovery, retirement, compact, and destroy come in later slices.
