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
import type { PiLauncher } from "../pi/adapter.js";
import { createLaunchProfile, observeSession } from "../pi/launch-profile.js";
import type { PiProcess } from "../pi/process.js";
import { err, ok, type Result } from "../shared/result.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";
import { AgentCoordinator } from "./agent-coordinator.js";
import { SessionTailSubscription } from "./session-tail-subscription.js";

interface RecordedOperation {
  readonly method: "create" | "send" | "destroy";
  readonly fingerprint: string;
  readonly result: Result<unknown, FleetClientError>;
}

export interface FleetServiceOptions {
  readonly launcher?: PiLauncher;
  readonly now?: () => string;
}

export class FleetService {
  readonly #operations = new Map<string, RecordedOperation>();
  readonly #coordinators = new Map<string, AgentCoordinator>();
  readonly #watchers = new Map<string, Set<AbortController>>();
  readonly #launcher: PiLauncher | undefined;
  readonly #now: () => string;

  constructor(
    private readonly store: FleetStore,
    options: FleetServiceOptions | (() => string) = {},
  ) {
    this.#launcher = typeof options === "function" ? undefined : options.launcher;
    this.#now =
      typeof options === "function" ? options : (options.now ?? (() => new Date().toISOString()));
  }

  async create(
    input: CreateInput,
    operationId: string,
  ): Promise<Result<CreateResult, FleetClientError>> {
    const replay = this.#operation<CreateResult>(operationId, "create", input);
    if (replay !== null) return replay;

    const profile = createLaunchProfile({
      cwd: input.cwd,
      piArgv: input.piArgv,
      piArtifactId: this.#launcher?.artifactId ?? "fake-pi",
    });
    let agent: StoredAgent = {
      summary: {
        id: randomUUID(),
        name: input.name,
        state: this.#launcher === undefined ? "idle" : "restoring",
        process: { state: this.#launcher === undefined ? "resident" : "starting" },
        session: { path: null, id: null },
      },
      launch: profile,
      latestAssistantText: null,
      responseObservedAt: null,
    };
    if (!(await this.store.createAgent(agent))) {
      const result = err<FleetClientError>({
        code: "name_taken",
        message: `Agent ${input.name} already exists.`,
      });
      this.#remember(operationId, "create", input, result);
      return result;
    }

    try {
      if (this.#launcher !== undefined) {
        const process = await this.#launcher.start(profile, false);
        const state = await process.getState();
        const observedProfile = observeSession(profile, {
          path: state.sessionFile ?? null,
          id: state.sessionId,
        });
        agent = {
          ...agent,
          launch: observedProfile,
          summary: {
            ...agent.summary,
            state: "idle",
            process: { state: "resident" },
            session: { path: state.sessionFile ?? null, id: state.sessionId },
          },
        };
        await this.store.putAgent(agent);
        const coordinator = this.#attachCoordinator(agent, process);
        if (input.instructions !== undefined) await coordinator.send(input.instructions);
        agent = coordinator.storedAgent;
      }

      const result = ok<CreateResult>({
        schemaVersion: 1,
        type: "agent.created",
        agent: agent.summary,
      });
      this.#remember(operationId, "create", input, result);
      return result;
    } catch (error: unknown) {
      const coordinator = this.#coordinators.get(input.name);
      if (coordinator !== undefined) await coordinator.stop().catch(() => undefined);
      this.#coordinators.delete(input.name);
      await this.store.deleteAgent(input.name);
      const result = err<FleetClientError>({
        code: "pi_start_failed",
        message: error instanceof Error ? error.message : "Pi failed to start.",
      });
      this.#remember(operationId, "create", input, result);
      return result;
    }
  }

  async send(input: SendInput, operationId: string): Promise<Result<SendResult, FleetClientError>> {
    const replay = this.#operation<SendResult>(operationId, "send", input);
    if (replay !== null) return replay;
    let agent = await this.store.getAgent(input.name);
    if (agent === null) return this.#rememberNotFound(operationId, "send", input);

    try {
      let coordinator = this.#coordinators.get(input.name);
      if (this.#launcher !== undefined && coordinator === undefined) {
        agent = await this.#markRestoring(agent);
        const process = await this.#launcher.start(agent.launch, true);
        const state = await process.getState();
        const profile = observeSession(agent.launch, {
          path: state.sessionFile ?? null,
          id: state.sessionId,
        });
        agent = {
          ...agent,
          launch: profile,
          summary: {
            ...agent.summary,
            state: "idle",
            process: { state: "resident" },
            session: { path: state.sessionFile ?? null, id: state.sessionId },
          },
        };
        await this.store.putAgent(agent);
        coordinator = this.#attachCoordinator(agent, process);
      }

      const acceptedAt = this.#now();
      if (coordinator === undefined) {
        await this.store.putAgent({
          ...agent,
          latestAssistantText: `Fake response to: ${input.message}`,
          responseObservedAt: acceptedAt,
        });
      } else {
        await coordinator.send(input.message);
      }
      const result = ok<SendResult>({
        schemaVersion: 1,
        type: "message.accepted",
        agent: { id: agent.summary.id, name: agent.summary.name },
        acceptedAt,
      });
      this.#remember(operationId, "send", input, result);
      return result;
    } catch (error: unknown) {
      const result = err<FleetClientError>({
        code: "pi_send_failed",
        message: error instanceof Error ? error.message : "Pi rejected the message.",
      });
      this.#remember(operationId, "send", input, result);
      return result;
    }
  }

  async receive(
    input: ReceiveInput,
    signal?: AbortSignal,
  ): Promise<Result<ReceiveResult, FleetClientError>> {
    const coordinator = this.#coordinators.get(input.name);
    const agent =
      coordinator === undefined
        ? await this.store.getAgent(input.name)
        : await coordinator.waitForIdle(signal);
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

  async openWatch(
    input: { readonly name: string },
    connectionSignal: AbortSignal,
  ): Promise<Result<AsyncIterable<Buffer>, FleetClientError>> {
    const agent = await this.store.getAgent(input.name);
    if (agent === null) return this.#notFound(input.name);
    const sessionPath = agent.summary.session.path;
    if (sessionPath === null) {
      return err({
        code: "session_unavailable",
        message: `Agent ${input.name} has no session path.`,
      });
    }

    const abort = new AbortController();
    const onConnectionAbort = () => abort.abort();
    connectionSignal.addEventListener("abort", onConnectionAbort, { once: true });
    const watchers = this.#watchers.get(input.name) ?? new Set<AbortController>();
    watchers.add(abort);
    this.#watchers.set(input.name, watchers);
    const subscription = new SessionTailSubscription(sessionPath, { signal: abort.signal });
    const cleanup = () => {
      connectionSignal.removeEventListener("abort", onConnectionAbort);
      watchers.delete(abort);
      if (watchers.size === 0) this.#watchers.delete(input.name);
    };
    return ok(watchWithCleanup(subscription, cleanup));
  }

  async destroy(
    input: DestroyInput,
    operationId: string,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    const replay = this.#operation<DestroyResult>(operationId, "destroy", input);
    if (replay !== null) return replay;
    for (const watcher of this.#watchers.get(input.name) ?? []) watcher.abort();
    this.#watchers.delete(input.name);
    const coordinator = this.#coordinators.get(input.name);
    if (coordinator !== undefined) await coordinator.stop();
    this.#coordinators.delete(input.name);
    const agent = await this.store.deleteAgent(input.name);
    if (agent === null) return this.#rememberNotFound(operationId, "destroy", input);
    const result = ok<DestroyResult>({
      schemaVersion: 1,
      type: "agent.destroyed",
      agent: { id: agent.summary.id, name: agent.summary.name },
    });
    this.#remember(operationId, "destroy", input, result);
    return result;
  }

  async releaseAgentProcess(name: string): Promise<void> {
    const coordinator = this.#coordinators.get(name);
    if (coordinator === undefined) return;
    await coordinator.stop();
    this.#coordinators.delete(name);
  }

  async close(): Promise<void> {
    for (const watchers of this.#watchers.values()) {
      for (const watcher of watchers) watcher.abort();
    }
    this.#watchers.clear();
    await Promise.all([...this.#coordinators.values()].map((coordinator) => coordinator.stop()));
    this.#coordinators.clear();
  }

  async #markRestoring(agent: StoredAgent): Promise<StoredAgent> {
    const restoring: StoredAgent = {
      ...agent,
      summary: { ...agent.summary, state: "restoring", process: { state: "starting" } },
    };
    await this.store.putAgent(restoring);
    return restoring;
  }

  #attachCoordinator(agent: StoredAgent, process: PiProcess): AgentCoordinator {
    const coordinator = new AgentCoordinator(this.store, agent, process, this.#now, () => {
      if (this.#coordinators.get(agent.summary.name) === coordinator) {
        this.#coordinators.delete(agent.summary.name);
      }
    });
    this.#coordinators.set(agent.summary.name, coordinator);
    return coordinator;
  }

  #notFound<T>(name: string): Result<T, FleetClientError> {
    return err({ code: "agent_not_found", message: `Agent ${name} was not found.` });
  }

  #rememberNotFound<T>(
    operationId: string,
    method: "send" | "destroy",
    payload: object,
  ): Result<T, FleetClientError> {
    const result = this.#notFound<T>(String("name" in payload ? payload.name : "unknown"));
    this.#remember(operationId, method, payload, result);
    return result;
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

async function* watchWithCleanup(
  subscription: AsyncIterable<Buffer>,
  cleanup: () => void,
): AsyncIterable<Buffer> {
  try {
    yield* subscription;
  } finally {
    cleanup();
  }
}
