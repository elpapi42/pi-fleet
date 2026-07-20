import type { AgentSummary } from "../client/fleet-client.js";
import type { AgentLaunchProfile } from "../pi/launch-profile.js";

export interface StoredAgent {
  readonly summary: AgentSummary;
  readonly launch: AgentLaunchProfile;
  readonly latestAssistantText: string | null;
  readonly responseObservedAt: string | null;
}

export interface StoredOperation {
  readonly operationId: string;
  readonly method: "create" | "send" | "destroy";
  readonly fingerprint: string;
  readonly state: "pending" | "completed";
  readonly result: unknown | null;
}

export interface StoredIncarnation {
  readonly incarnationId: string;
  readonly agentName: string;
  readonly pid: number | null;
  readonly state: "starting" | "live" | "stopping" | "cleanup_uncertain" | "gone";
}

export interface StoredSend {
  readonly sendId: string;
  readonly agentName: string;
  readonly message: string;
  readonly state: "pending" | "dispatching" | "acknowledged" | "failed" | "uncertain";
  readonly acceptedAt: string;
}

export interface FleetStore {
  createAgent(agent: StoredAgent): Promise<boolean>;
  getAgent(name: string): Promise<StoredAgent | null>;
  listAgents(): Promise<readonly StoredAgent[]>;
  putAgent(agent: StoredAgent): Promise<void>;
  deleteAgent(name: string): Promise<StoredAgent | null>;

  getOperation(operationId: string): Promise<StoredOperation | null>;
  putOperation(operation: StoredOperation): Promise<void>;

  getSend(sendId: string): Promise<StoredSend | null>;
  putSend(send: StoredSend): Promise<void>;
  listNonterminalSends(): Promise<readonly StoredSend[]>;

  putIncarnation(incarnation: StoredIncarnation): Promise<void>;
  listActiveIncarnations(): Promise<readonly StoredIncarnation[]>;

  close(cleanShutdown?: boolean): Promise<void>;
}
