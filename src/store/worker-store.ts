import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type {
  FleetStore,
  StoredAgent,
  StoredIncarnation,
  StoredOperation,
  StoredSend,
} from "./fleet-store.js";

interface WorkerResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export class WorkerFleetStore implements FleetStore {
  readonly #worker: Worker;
  readonly #pending = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  #closed = false;

  constructor(path: string, workerUrl = new URL("./sqlite-worker.mjs", import.meta.url)) {
    this.#worker = new Worker(workerUrl, { workerData: { path } });
    this.#worker.on("message", (response: WorkerResponse) => {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "SQLite worker failed"));
    });
    this.#worker.on("error", (error) => this.#rejectAll(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed)
        this.#rejectAll(new Error(`SQLite worker exited unexpectedly with ${code}`));
    });
  }

  createAgent(agent: StoredAgent): Promise<boolean> {
    return this.#call("createAgent", [agent]);
  }

  getAgent(name: string): Promise<StoredAgent | null> {
    return this.#call("getAgent", [name]);
  }

  listAgents(): Promise<readonly StoredAgent[]> {
    return this.#call("listAgents", []);
  }

  async putAgent(agent: StoredAgent): Promise<void> {
    await this.#call("putAgent", [agent]);
  }

  getOperation(operationId: string): Promise<StoredOperation | null> {
    return this.#call("getOperation", [operationId]);
  }

  async putOperation(operation: StoredOperation): Promise<void> {
    await this.#call("putOperation", [operation]);
  }

  listPendingOperations(): Promise<readonly StoredOperation[]> {
    return this.#call("listPendingOperations", []);
  }

  async deleteOperation(operationId: string): Promise<void> {
    await this.#call("deleteOperation", [operationId]);
  }

  getSend(sendId: string): Promise<StoredSend | null> {
    return this.#call("getSend", [sendId]);
  }

  nextSendOrdinal(agentName: string): Promise<number> {
    return this.#call("nextSendOrdinal", [agentName]);
  }

  async putSend(send: StoredSend): Promise<void> {
    await this.#call("putSend", [send]);
  }

  listNonterminalSends(): Promise<readonly StoredSend[]> {
    return this.#call("listNonterminalSends", []);
  }

  async putIncarnation(incarnation: StoredIncarnation): Promise<void> {
    await this.#call("putIncarnation", [incarnation]);
  }

  listActiveIncarnations(): Promise<readonly StoredIncarnation[]> {
    return this.#call("listActiveIncarnations", []);
  }

  deleteAgent(name: string): Promise<StoredAgent | null> {
    return this.#call("deleteAgent", [name]);
  }

  async close(cleanShutdown = true): Promise<void> {
    if (this.#closed) return;
    await this.#call("close", [cleanShutdown]);
    this.#closed = true;
    await this.#worker.terminate();
  }

  #call<T>(method: string, args: readonly unknown[]): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Fleet store is closed"));
    const id = randomUUID();
    const result = new Promise<T>((resolveCall, rejectCall) => {
      this.#pending.set(id, {
        resolve: (value) => resolveCall(value as T),
        reject: rejectCall,
      });
    });
    this.#worker.postMessage({ id, method, args });
    return result;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
