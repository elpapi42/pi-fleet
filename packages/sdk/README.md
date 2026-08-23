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

Running agents keep the worker version used at creation. After updating the SDK, create a new agent before testing new worker behavior such as live receive. Until `destroy` exists, use a new agent name.

`agent.send(message)` starts work when Pi is idle. During active work, it uses `steer` by default. Use `followUp` to deliver after the current work settles:

```ts
await agent.send("Summarize the findings", { delivery: "followUp" })
```

`send()` resolves after Pi accepts or queues the instruction. It does not wait for completion.

`agent.receive()` provides best-effort live activity after the subscription starts. Each client receives an independent stream. Slice 3 does not replay missed events. The stream reports `thinking.started`, `thinking.finished`, `message.started`, `message.finished`, `tool.started`, and `tool.finished`. It ends normally when the consumer stops or the client closes. It throws if the worker or Pi becomes unavailable.

Each event has a live `eventId`, an `activityId` that connects matching start and finish events, and a worker-assigned Unix-millisecond `timestamp`. A late subscriber can receive only one side of an activity pair. Stream order is authoritative; timestamps do not define ordering. `eventId` is not a replay cursor. `message.finished.text` contains concatenated assistant text blocks only. Each value returned by `agent.receive()` is a single-consumer stream; call `receive()` again for another independent subscription. Slice 4 will add durable sequence cursors and replay.

`tool.started.args` contains Pi's model-requested parameters. Pi can validate or transform them before execution. `tool.finished.output` contains bounded final text, image omission metadata, and optional structured details. It never contains base64 image data. The worker limits requested parameters to 16 KiB, text output to 64 KiB, structured details to 16 KiB, and the CLI preview to 8 KiB. `tool.updated` is not available yet.

Slice 3 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides create, get, list, status, send, and live receive. Recovery, durable replay, retirement, compact, and destroy come in later slices.
