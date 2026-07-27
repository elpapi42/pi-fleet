import { parentPort, workerData } from "node:worker_threads";

import { dispatchJournalStoreRequest } from "./journal-worker-dispatch.js";
import type { JournalWorkerRequest } from "./journal-worker-protocol.js";
import { SqliteJournalStore } from "./sqlite-journal-store.js";

const port = parentPort;
if (port === null) throw new Error("Journal SQLite worker requires a parent port");
const options = workerData as {
  readonly path?: unknown;
  readonly checkpointCommitInterval?: unknown;
  readonly reclaimPagesPerPass?: unknown;
};
if (typeof options.path !== "string") {
  throw new Error("Journal SQLite worker requires a database path");
}
if (
  typeof options.checkpointCommitInterval !== "number" ||
  typeof options.reclaimPagesPerPass !== "number"
) {
  throw new Error("Journal SQLite worker requires maintenance limits");
}
const store = new SqliteJournalStore(options.path, {
  checkpointCommitInterval: options.checkpointCommitInterval,
  reclaimPagesPerPass: options.reclaimPagesPerPass,
});

port.on("message", (request: JournalWorkerRequest) => {
  void dispatchJournalStoreRequest(store, request)
    .then((value) => port.postMessage({ id: request.id, ok: true, value }))
    .catch((error: unknown) =>
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "Journal SQLite worker failed",
      }),
    );
});
