import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null) throw new Error("faulty store fixture requires a worker parent");

if (workerData.path === "exit") {
  setImmediate(() => process.exit(23));
} else if (workerData.path === "malformed") {
  parentPort.once("message", () => parentPort.postMessage({ malformed: true }));
} else {
  throw new Error(`unknown faulty store mode: ${String(workerData.path)}`);
}
