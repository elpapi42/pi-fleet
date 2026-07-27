import type { AgentSummary, FleetClientError } from "../client/fleet-client.js";
import type { AgentLaunchProfile } from "../pi/launch-profile.js";

export interface StoredAgent {
  readonly summary: AgentSummary;
  readonly launch: AgentLaunchProfile;
}

export interface StoredOperation {
  readonly operationId: string;
  readonly method: "create" | "send" | "destroy" | "compact";
  readonly fingerprint: string;
  readonly state: "pending" | "completed";
  readonly result: unknown | null;
  readonly targetName: string;
  readonly targetAgent?: { readonly id: string; readonly name: string };
  /**
   * Exact request payload retained only while the mutation is in flight so a
   * crash can resume proven-undispatched work. Completed operations drop it so
   * durable receipts keep no instruction, message, cwd, or Pi argument content.
   */
  readonly request?: unknown;
}

export interface StoredIncarnation {
  readonly incarnationId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly pid: number | null;
  readonly state: "starting" | "live" | "stopping" | "cleanup_uncertain" | "gone";
}

export interface StoredCompact {
  readonly compactId: string;
  readonly agentId: string;
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
  readonly agentId: string;
  readonly agentName: string;
  readonly ordinal?: number;
  readonly message: string;
  readonly delivery: "steer" | "followUp";
  readonly state: "pending" | "dispatching" | "acknowledged" | "failed" | "uncertain";
  readonly acceptedAt: string;
}

export interface FleetStore {
  createAgent(agent: StoredAgent, operation?: StoredOperation): Promise<boolean>;
  getAgent(name: string): Promise<StoredAgent | null>;
  listAgents(): Promise<readonly StoredAgent[]>;
  putAgent(agent: StoredAgent): Promise<void>;
  rollbackProvisionalCreate(
    name: string,
    completedOperation: StoredOperation,
  ): Promise<StoredAgent | null>;
  deleteAgent(
    name: string,
    receipt?: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly destroyedAt: string;
    },
  ): Promise<StoredAgent | null>;

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
