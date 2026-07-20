import { randomUUID } from "node:crypto";

import type {
  CreateInput,
  CreateResult,
  DestroyInput,
  DestroyResult,
  FleetClientError,
  ListResult,
  ReceiveInput,
  ReceiveResult,
  SendInput,
  SendResult,
  StatusInput,
  StatusResult,
} from "../client/fleet-client.js";
import { err, ok, type Result } from "../shared/result.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";

interface RecordedOperation {
  readonly method: "create" | "send" | "destroy";
  readonly fingerprint: string;
  readonly result: Result<unknown, FleetClientError>;
}

export class FleetService {
  readonly #operations = new Map<string, RecordedOperation>();

  constructor(
    private readonly store: FleetStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(
    input: CreateInput,
    operationId: string,
  ): Promise<Result<CreateResult, FleetClientError>> {
    const replay = this.#operation<CreateResult>(operationId, "create", input);
    if (replay !== null) return replay;

    const agent: StoredAgent = {
      summary: {
        id: randomUUID(),
        name: input.name,
        state: "idle",
        process: { state: "resident" },
        session: { path: null, id: null },
      },
      launch: input,
      latestAssistantText: null,
      responseObservedAt: null,
    };
    const result = (await this.store.createAgent(agent))
      ? ok<CreateResult>({ schemaVersion: 1, type: "agent.created", agent: agent.summary })
      : err<FleetClientError>({
          code: "name_taken",
          message: `Agent ${input.name} already exists.`,
        });
    this.#remember(operationId, "create", input, result);
    return result;
  }

  async send(input: SendInput, operationId: string): Promise<Result<SendResult, FleetClientError>> {
    const replay = this.#operation<SendResult>(operationId, "send", input);
    if (replay !== null) return replay;
    const agent = await this.store.getAgent(input.name);
    if (agent === null) {
      const result = this.#notFound<SendResult>(input.name);
      this.#remember(operationId, "send", input, result);
      return result;
    }
    const observedAt = this.now();
    await this.store.putAgent({
      ...agent,
      latestAssistantText: `Fake response to: ${input.message}`,
      responseObservedAt: observedAt,
    });
    const result = ok<SendResult>({
      schemaVersion: 1,
      type: "message.accepted",
      agent: { id: agent.summary.id, name: agent.summary.name },
      acceptedAt: observedAt,
    });
    this.#remember(operationId, "send", input, result);
    return result;
  }

  async receive(input: ReceiveInput): Promise<Result<ReceiveResult, FleetClientError>> {
    const agent = await this.store.getAgent(input.name);
    if (agent === null) return this.#notFound(input.name);
    if (agent.latestAssistantText === null || agent.responseObservedAt === null) {
      return err({
        code: "no_response",
        message: `Agent ${input.name} has no assistant response.`,
      });
    }
    return ok({
      schemaVersion: 1,
      type: "response",
      agent: { id: agent.summary.id, name: agent.summary.name },
      response: { text: agent.latestAssistantText, observedAt: agent.responseObservedAt },
    });
  }

  async status(input: StatusInput): Promise<Result<StatusResult, FleetClientError>> {
    const agent = await this.store.getAgent(input.name);
    return agent === null
      ? this.#notFound(input.name)
      : ok({ schemaVersion: 1, type: "agent.status", agent: agent.summary });
  }

  async list(): Promise<Result<ListResult, FleetClientError>> {
    const agents = await this.store.listAgents();
    return ok({
      schemaVersion: 1,
      type: "agent.list",
      agents: agents.map((agent) => agent.summary),
    });
  }

  async destroy(
    input: DestroyInput,
    operationId: string,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    const replay = this.#operation<DestroyResult>(operationId, "destroy", input);
    if (replay !== null) return replay;
    const agent = await this.store.deleteAgent(input.name);
    if (agent === null) {
      const result = this.#notFound<DestroyResult>(input.name);
      this.#remember(operationId, "destroy", input, result);
      return result;
    }
    const result = ok<DestroyResult>({
      schemaVersion: 1,
      type: "agent.destroyed",
      agent: { id: agent.summary.id, name: agent.summary.name },
    });
    this.#remember(operationId, "destroy", input, result);
    return result;
  }

  #notFound<T>(name: string): Result<T, FleetClientError> {
    return err({ code: "agent_not_found", message: `Agent ${name} was not found.` });
  }

  #operation<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
  ): Result<T, FleetClientError> | null {
    const recorded = this.#operations.get(operationId);
    if (recorded === undefined) return null;
    if (recorded.method !== method || recorded.fingerprint !== JSON.stringify(payload)) {
      return err({
        code: "operation_conflict",
        message: `Operation ${operationId} was already used with a different request.`,
      });
    }
    return recorded.result as Result<T, FleetClientError>;
  }

  #remember<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
    result: Result<T, FleetClientError>,
  ): void {
    this.#operations.set(operationId, {
      method,
      fingerprint: JSON.stringify(payload),
      result,
    });
  }
}
