import type { AgentSummary, FleetClientError } from "../client/fleet-client.js";
import type { AgentLaunchProfile } from "../pi/launch-profile.js";

export interface StoredAgent {
  readonly summary: AgentSummary;
  readonly launch: AgentLaunchProfile;
  readonly latestAssistantText: string | null;
  readonly responseObservedAt: string | null;
}

export interface StoredOperation {
  readonly operationId: string;
  readonly method: "create" | "send" | "destroy" | "compact";
  readonly fingerprint: string;
  readonly state: "pending" | "completed";
  readonly result: unknown | null;
  readonly targetAgent?: { readonly id: string; readonly name: string };
}

export interface StoredIncarnation {
  readonly incarnationId: string;
  readonly agentName: string;
  readonly pid: number | null;
  readonly state: "starting" | "live" | "stopping" | "cleanup_uncertain" | "gone";
}

export interface StoredCompact {
  readonly compactId: string;
  readonly agentName: string;
  readonly state: "pending" | "dispatching" | "completed" | "failed" | "uncertain";
  readonly requestedAt: string;
  readonly result?: {
    readonly tokensBefore: number;
    readonly estimatedTokensAfter?: number;
  };
  readonly error?: FleetClientError;
}

export interface StoredSend {
  readonly sendId: string;
  readonly agentName: string;
  readonly ordinal?: number;
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
  listPendingOperations(): Promise<readonly StoredOperation[]>;
  deleteOperation(operationId: string): Promise<void>;

  getSend(sendId: string): Promise<StoredSend | null>;
  nextSendOrdinal(agentName: string): Promise<number>;
  putSend(send: StoredSend): Promise<void>;
  listNonterminalSends(): Promise<readonly StoredSend[]>;

  getCompact(compactId: string): Promise<StoredCompact | null>;
  putCompact(compact: StoredCompact): Promise<void>;
  listNonterminalCompacts(): Promise<readonly StoredCompact[]>;

  putIncarnation(incarnation: StoredIncarnation): Promise<void>;
  listActiveIncarnations(): Promise<readonly StoredIncarnation[]>;

  close(cleanShutdown?: boolean): Promise<void>;
}
