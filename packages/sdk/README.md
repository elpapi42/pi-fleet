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

`client.get(name)` and `client.list()` discover agents created by another local client. `client.close()` only closes this SDK client. It does not stop an agent worker.

Slice 1 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides create, get, list, and status. Sending work, event streaming, recovery, retirement, compact, and destroy come in later slices.
