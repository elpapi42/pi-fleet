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

`agent.receive()` provides a durable semantic activity stream. Each client receives an independent single-consumer stream. The stream reports `thinking.started`, `thinking.finished`, `message.started`, `message.finished`, `tool.started`, and `tool.finished`. It ends normally when the consumer stops or the client closes. It throws `AgentUnavailableError` if the worker or Pi becomes unavailable.

Every event has an opaque `cursor`, a semantic `eventId`, an `activityId` that connects matching start and finish events, and a worker-assigned Unix-millisecond `timestamp`. Stream order is authoritative. Timestamps do not define ordering, and `eventId` is not a replay cursor. `message.finished.text` contains concatenated assistant text blocks only.

```ts
let cursor: string | undefined
for await (const event of agent.receive({ fromStart: true })) {
  cursor = event.cursor
}

for await (const event of agent.receive({ after: cursor })) {
  // Events after cursor, then live events.
}
```

Plain `receive()` starts after the tail captured at subscription time. `receive({ fromStart: true })` starts from the first event. `receive({ after: cursor })` starts after that cursor. The options are mutually exclusive. Cursors are versioned opaque values that bind to one immutable agent ID. Invalid, wrong-agent, or future cursors throw `InvalidCursorError`.

`tool.started.args` contains Pi's model-requested parameters. Pi can validate or transform them before execution. When `argsTruncated` is `true`, `args` is `null` because the requested parameters exceeded 16 KiB.

`tool.finished.output` contains bounded final text, image omission metadata, and optional structured details. `detailsTruncated` reports omitted structured details. `truncated` reports any omitted or shortened output, including image data. Semantic events never contain base64 image data. The worker limits text output to 64 KiB and structured details to 16 KiB. The CLI shows at most 8 KiB per parameter or output preview. `tool.updated` is not available yet.

Tool parameters and output can contain sensitive local data. Pi-fleet does not silently redact this data because redaction can change its meaning. The same bounded event data persists in `~/.pi-fleet` until `destroy()` exists. There is no expiry or retention setting yet, so disk use can grow. SDK consumers must treat event history as having the same local trust level as the agent and its Pi session.

Slice 4 supports Unix-like hosts with ZeroMQ `ipc://` support. It provides create, get, list, status, send, and durable receive. Pi and worker recovery, retirement, compact, and destroy come in later slices. A missing worker still makes receive unavailable until worker recovery arrives.
