import { parentPort, workerData } from "node:worker_threads";

import type { StoredAgent, StoredIncarnation, StoredOperation, StoredSend } from "./fleet-store.js";
import { SqliteFleetStore } from "./sqlite-store.js";

interface WorkerRequest {
  readonly id: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

const port = parentPort;
if (port === null) throw new Error("SQLite worker requires a parent port");
const path = (workerData as { path?: unknown }).path;
if (typeof path !== "string") throw new Error("SQLite worker requires a database path");
const store = new SqliteFleetStore(path);

port.on("message", (request: WorkerRequest) => {
  void dispatch(request)
    .then((value) => port.postMessage({ id: request.id, ok: true, value }))
    .catch((error: unknown) =>
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "SQLite worker failed",
      }),
    );
});

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case "createAgent":
      return store.createAgent(request.args[0] as StoredAgent);
    case "getAgent":
      return store.getAgent(request.args[0] as string);
    case "listAgents":
      return store.listAgents();
    case "putAgent":
      return store.putAgent(request.args[0] as StoredAgent);
    case "deleteAgent":
      return store.deleteAgent(request.args[0] as string);
    case "getOperation":
      return store.getOperation(request.args[0] as string);
    case "putOperation":
      return store.putOperation(request.args[0] as StoredOperation);
    case "listPendingOperations":
      return store.listPendingOperations();
    case "deleteOperation":
      return store.deleteOperation(request.args[0] as string);
    case "getSend":
      return store.getSend(request.args[0] as string);
    case "nextSendOrdinal":
      return store.nextSendOrdinal(request.args[0] as string);
    case "putSend":
      return store.putSend(request.args[0] as StoredSend);
    case "listNonterminalSends":
      return store.listNonterminalSends();
    case "putIncarnation":
      return store.putIncarnation(request.args[0] as StoredIncarnation);
    case "listActiveIncarnations":
      return store.listActiveIncarnations();
    case "close":
      return store.close(request.args[0] as boolean | undefined);
    default:
      throw new Error(`Unknown SQLite worker method ${request.method}`);
  }
}
