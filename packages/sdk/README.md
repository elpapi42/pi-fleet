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
  instructions: "Give concise answers.",
})

console.log(await agent.status())
await client.close()
```

`instructions` adds durable system instructions. It does not send initial work.

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

Slice 1 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides create, get, list, and status. Sending work, event streaming, recovery, retirement, compact, and destroy come in later slices.
