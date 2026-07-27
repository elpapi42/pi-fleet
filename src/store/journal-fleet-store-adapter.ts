import type { FleetClientError } from "../client/fleet-client.js";
import type { AgentId, IncarnationId } from "../runtime/semantic-events.js";
import type {
  FleetStore,
  StoredAgent,
  StoredCompact,
  StoredIncarnation,
  StoredOperation,
  StoredSend,
} from "./fleet-store.js";
import type {
  JournalAgent,
  JournalCompact,
  JournalOperation,
  JournalSend,
  JournalStore,
} from "./journal-store.js";

/**
 * Transitional service adapter selected only by the coordinated schema cutover.
 * It keeps the mature lifecycle service while making the journal store's UUID
 * ownership authoritative at every persistence boundary.
 */
export class JournalFleetStoreAdapter implements FleetStore {
  constructor(readonly journal: JournalStore) {}

  async createAgent(agent: StoredAgent, operation?: StoredOperation): Promise<boolean> {
    if (operation === undefined) return this.journal.createAgent(toJournalAgent(agent));
    return this.journal.createAgentWithOperation(
      toJournalAgent(agent),
      toJournalOperation(operation, agent.summary.id as AgentId),
    );
  }

  async getAgent(name: string): Promise<StoredAgent | null> {
    return fromJournalAgent(await this.journal.getAgentByName(name));
  }

  async listAgents(): Promise<readonly StoredAgent[]> {
    return (await this.journal.listAgents()).map((agent) => fromJournalAgent(agent)!);
  }

  putAgent(agent: StoredAgent): Promise<void> {
    return this.journal.putAgent(toJournalAgent(agent));
  }

  async rollbackProvisionalCreate(
    name: string,
    completedOperation: StoredOperation,
  ): Promise<StoredAgent | null> {
    const existing = await this.journal.getAgentByName(name);
    if (existing === null) return null;
    return fromJournalAgent(
      await this.journal.rollbackProvisionalCreate(
        existing.agentId,
        toJournalOperation(completedOperation, undefined),
      ),
    );
  }

  async deleteAgent(
    name: string,
    receipt?: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly destroyedAt: string;
    },
  ): Promise<StoredAgent | null> {
    const existing = await this.journal.getAgentByName(name);
    if (existing === null) return null;
    const destroyed = await this.journal.destroyAgent(existing.agentId, {
      operationId: receipt?.operationId ?? `rollback:${existing.agentId}`,
      agentId: existing.agentId,
      agentName: existing.name,
      fingerprint: receipt?.fingerprint ?? "rollback",
      destroyedAt: receipt?.destroyedAt ?? new Date().toISOString(),
      status: "destroyed",
    });
    return fromJournalAgent(destroyed);
  }

  async getOperation(operationId: string): Promise<StoredOperation | null> {
    const operation = await this.journal.getOperation(operationId);
    if (operation !== null) return fromJournalOperation(operation);
    const receipt = await this.journal.getDestroyReceipt(operationId);
    if (receipt === null) return null;
    return {
      operationId,
      method: "destroy",
      fingerprint: receipt.fingerprint,
      state: "completed",
      result: {
        ok: true,
        value: {
          schemaVersion: 1,
          type: "agent.destroyed",
          agent: { id: receipt.agentId, name: receipt.agentName },
        },
      },
      targetName: receipt.agentName,
      targetAgent: { id: receipt.agentId, name: receipt.agentName },
    };
  }

  async putOperation(operation: StoredOperation): Promise<void> {
    if (
      operation.method === "destroy" &&
      operation.state === "completed" &&
      (await this.journal.getDestroyReceipt(operation.operationId)) !== null
    ) {
      return;
    }
    await this.journal.putOperation(
      toJournalOperation(operation, operation.targetAgent?.id as AgentId | undefined),
    );
  }

  async listPendingOperations(): Promise<readonly StoredOperation[]> {
    return (await this.journal.listPendingOperations()).map((operation) =>
      fromJournalOperation(operation),
    );
  }

  async deleteOperation(operationId: string): Promise<void> {
    await this.journal.deleteOperation(operationId);
  }

  async getSend(sendId: string): Promise<StoredSend | null> {
    return fromJournalSend(
      await this.journal.getSend(sendId),
      await this.#agentNameForSend(sendId),
    );
  }

  async nextSendOrdinal(agentName: string): Promise<number> {
    const agent = await this.#requireAgentByName(agentName);
    return this.journal.nextSendOrdinal(agent.agentId);
  }

  async putSend(send: StoredSend): Promise<void> {
    const agent = await this.#requireAgentByName(send.agentName);
    if (send.agentId === undefined || agent.agentId !== send.agentId) {
      throw new Error("Send is missing its immutable agent generation");
    }
    await this.journal.putSend({
      sendId: send.sendId,
      agentId: send.agentId as AgentId,
      ordinal: send.ordinal ?? (await this.journal.nextSendOrdinal(agent.agentId)),
      message: send.message,
      delivery: send.delivery ?? "steer",
      state: send.state,
      acceptedAt: send.acceptedAt,
    });
  }

  async listNonterminalSends(): Promise<readonly StoredSend[]> {
    const sends = await this.journal.listNonterminalSends();
    return Promise.all(
      sends.map(async (send) => {
        const agent = await this.journal.getAgentById(send.agentId);
        if (agent === null) throw new Error("Send targets a deleted agent generation");
        return fromJournalSend(send, agent.name)!;
      }),
    );
  }

  async getCompact(compactId: string): Promise<StoredCompact | null> {
    const compact = await this.journal.getCompact(compactId);
    if (compact === null) return null;
    const agent = await this.journal.getAgentById(compact.agentId);
    if (agent === null) return null;
    return fromJournalCompact(compact, agent.name);
  }

  async putCompact(compact: StoredCompact): Promise<void> {
    const agent = await this.#requireAgentByName(compact.agentName);
    if (compact.agentId === undefined || agent.agentId !== compact.agentId) {
      throw new Error("Compaction is missing its immutable agent generation");
    }
    await this.journal.putCompact({
      compactId: compact.compactId,
      agentId: compact.agentId as AgentId,
      state: compact.state,
      requestedAt: compact.requestedAt,
      ...(compact.result === undefined ? {} : { result: compact.result }),
      ...(compact.error === undefined ? {} : { error: compact.error }),
    });
  }

  async listNonterminalCompacts(): Promise<readonly StoredCompact[]> {
    const compacts = await this.journal.listNonterminalCompacts();
    return Promise.all(
      compacts.map(async (compact) => {
        const agent = await this.journal.getAgentById(compact.agentId);
        if (agent === null) throw new Error("Compaction targets a deleted agent generation");
        return fromJournalCompact(compact, agent.name);
      }),
    );
  }

  async putIncarnation(incarnation: StoredIncarnation): Promise<void> {
    const agent = await this.#requireAgentByName(incarnation.agentName);
    if (incarnation.agentId === undefined || agent.agentId !== incarnation.agentId) {
      throw new Error("Incarnation is missing its immutable agent generation");
    }
    await this.journal.putIncarnation({
      incarnationId: incarnation.incarnationId as IncarnationId,
      agentId: incarnation.agentId as AgentId,
      pid: incarnation.pid,
      state: incarnation.state,
    });
  }

  async listActiveIncarnations(): Promise<readonly StoredIncarnation[]> {
    const incarnations = await this.journal.listActiveIncarnations();
    return Promise.all(
      incarnations.map(async (incarnation) => {
        const agent = await this.journal.getAgentById(incarnation.agentId);
        if (agent === null) throw new Error("Incarnation targets a deleted agent generation");
        return {
          incarnationId: incarnation.incarnationId,
          agentId: incarnation.agentId,
          agentName: agent.name,
          pid: incarnation.pid,
          state: incarnation.state,
        };
      }),
    );
  }

  close(): Promise<void> {
    return this.journal.close();
  }

  async #requireAgentByName(name: string): Promise<JournalAgent> {
    const agent = await this.journal.getAgentByName(name);
    if (agent === null) throw new Error(`Agent ${name} no longer exists`);
    return agent;
  }

  async #agentNameForSend(sendId: string): Promise<string | null> {
    const send = await this.journal.getSend(sendId);
    if (send === null) return null;
    return (await this.journal.getAgentById(send.agentId))?.name ?? null;
  }
}

function toJournalAgent(agent: StoredAgent): JournalAgent {
  return {
    agentId: agent.summary.id as AgentId,
    name: agent.summary.name,
    summary: agent.summary,
    launch: agent.launch,
  };
}

function fromJournalAgent(agent: JournalAgent | null): StoredAgent | null {
  if (agent === null) return null;
  return {
    summary: agent.summary,
    launch: agent.launch,
  };
}

function fromJournalOperation(operation: JournalOperation): StoredOperation {
  return {
    operationId: operation.operationId,
    method: operation.method,
    fingerprint: operation.fingerprint,
    state: operation.state,
    result: operation.result,
    targetName: operation.targetName,
    ...(operation.agentId === null
      ? {}
      : { targetAgent: { id: operation.agentId, name: operation.targetName } }),
    ...(operation.state === "pending" && operation.request !== undefined
      ? { request: operation.request }
      : {}),
  };
}

function toJournalOperation(
  operation: StoredOperation,
  targetId: AgentId | undefined,
): JournalOperation {
  return {
    operationId: operation.operationId,
    agentId: targetId ?? null,
    targetName: operation.targetName ?? operation.targetAgent?.name ?? "",
    method: operation.method,
    fingerprint: operation.fingerprint,
    state: operation.state,
    result: operation.result,
    ...(operation.state === "pending" && operation.request !== undefined
      ? { request: operation.request }
      : {}),
  };
}

function fromJournalSend(send: JournalSend | null, name: string | null): StoredSend | null {
  if (send === null || name === null) return null;
  return {
    sendId: send.sendId,
    agentId: send.agentId,
    agentName: name,
    ordinal: send.ordinal,
    message: send.message,
    delivery: send.delivery,
    state: send.state,
    acceptedAt: send.acceptedAt,
  };
}

function fromJournalCompact(compact: JournalCompact, name: string): StoredCompact {
  return {
    compactId: compact.compactId,
    agentId: compact.agentId,
    agentName: name,
    state: compact.state,
    requestedAt: compact.requestedAt,
    ...(compact.result === undefined ? {} : { result: compact.result }),
    ...(compact.error === undefined ? {} : { error: compact.error as FleetClientError }),
  };
}
