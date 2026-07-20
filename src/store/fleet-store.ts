import type { AgentSummary } from "../client/fleet-client.js";
import type { AgentLaunchProfile } from "../pi/launch-profile.js";

export interface StoredAgent {
  readonly summary: AgentSummary;
  readonly launch: AgentLaunchProfile;
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
