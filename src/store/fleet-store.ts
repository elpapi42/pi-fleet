import type { AgentSummary, CreateInput } from "../client/fleet-client.js";

export interface StoredAgent {
  readonly summary: AgentSummary;
  readonly launch: CreateInput;
  readonly latestAssistantText: string | null;
  readonly responseObservedAt: string | null;
}

export interface FleetStore {
  createAgent(agent: StoredAgent): Promise<boolean>;
  getAgent(name: string): Promise<StoredAgent | null>;
  listAgents(): Promise<readonly StoredAgent[]>;
  putAgent(agent: StoredAgent): Promise<void>;
  deleteAgent(name: string): Promise<StoredAgent | null>;
}
