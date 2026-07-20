import type {
  FleetStore,
  StoredAgent,
  StoredIncarnation,
  StoredOperation,
  StoredSend,
} from "./fleet-store.js";

export class MemoryFleetStore implements FleetStore {
  readonly #agents = new Map<string, StoredAgent>();
  readonly #operations = new Map<string, StoredOperation>();
  readonly #sends = new Map<string, StoredSend>();
  readonly #incarnations = new Map<string, StoredIncarnation>();

  async createAgent(agent: StoredAgent): Promise<boolean> {
    if (this.#agents.has(agent.summary.name)) return false;
    this.#agents.set(agent.summary.name, agent);
    return true;
  }

  async getAgent(name: string): Promise<StoredAgent | null> {
    return this.#agents.get(name) ?? null;
  }

  async listAgents(): Promise<readonly StoredAgent[]> {
    return [...this.#agents.values()].sort((left, right) =>
      left.summary.name.localeCompare(right.summary.name),
    );
  }

  async putAgent(agent: StoredAgent): Promise<void> {
    this.#agents.set(agent.summary.name, agent);
  }

  async deleteAgent(name: string): Promise<StoredAgent | null> {
    const existing = this.#agents.get(name) ?? null;
    if (existing !== null) this.#agents.delete(name);
    return existing;
  }

  async getOperation(operationId: string): Promise<StoredOperation | null> {
    return this.#operations.get(operationId) ?? null;
  }

  async putOperation(operation: StoredOperation): Promise<void> {
    this.#operations.set(operation.operationId, operation);
  }

  async listPendingOperations(): Promise<readonly StoredOperation[]> {
    return [...this.#operations.values()].filter((operation) => operation.state === "pending");
  }

  async deleteOperation(operationId: string): Promise<void> {
    this.#operations.delete(operationId);
  }

  async getSend(sendId: string): Promise<StoredSend | null> {
    return this.#sends.get(sendId) ?? null;
  }

  async nextSendOrdinal(agentName: string): Promise<number> {
    return (
      Math.max(
        0,
        ...[...this.#sends.values()]
          .filter((send) => send.agentName === agentName)
          .map((send) => send.ordinal ?? 0),
      ) + 1
    );
  }

  async putSend(send: StoredSend): Promise<void> {
    this.#sends.set(send.sendId, send);
  }

  async listNonterminalSends(): Promise<readonly StoredSend[]> {
    return [...this.#sends.values()].filter(
      (send) => send.state === "pending" || send.state === "dispatching",
    );
  }

  async putIncarnation(incarnation: StoredIncarnation): Promise<void> {
    this.#incarnations.set(incarnation.incarnationId, incarnation);
  }

  async listActiveIncarnations(): Promise<readonly StoredIncarnation[]> {
    return [...this.#incarnations.values()].filter((incarnation) =>
      ["starting", "live", "stopping", "cleanup_uncertain"].includes(incarnation.state),
    );
  }

  async close(): Promise<void> {
    // Memory state has no external resources.
  }
}
