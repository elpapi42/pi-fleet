import type { FleetStore, StoredAgent } from "./fleet-store.js";

export class MemoryFleetStore implements FleetStore {
  readonly #agents = new Map<string, StoredAgent>();

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
}
