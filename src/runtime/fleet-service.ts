import { randomUUID } from "node:crypto";

import type {
  CompactInput,
  CompactResult,
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
import { PiCleanupUncertainError, PiCompactionError, type PiProcess } from "../pi/process.js";
import { waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import { err, ok, type Result } from "../shared/result.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../shared/runtime-limits.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";
import { AgentCoordinator } from "./agent-coordinator.js";
import { SessionTailSubscription } from "./session-tail-subscription.js";

interface RecordedOperation {
  readonly method: "create" | "send" | "destroy" | "compact";
  readonly fingerprint: string;
  readonly result: Result<unknown, FleetClientError>;
}

export interface FleetServiceOptions {
  readonly launcher?: PiLauncher;
  readonly now?: () => string;
  readonly limits?: Partial<RuntimeLimits>;
}

export class FleetService {
  readonly #operations = new Map<string, RecordedOperation>();
  readonly #inflightOperations = new Map<
    string,
    {
      readonly method: RecordedOperation["method"];
      readonly fingerprint: string;
      readonly promise: Promise<Result<unknown, FleetClientError>>;
    }
  >();
  readonly #coordinators = new Map<string, AgentCoordinator>();
  readonly #watchers = new Map<string, Set<AbortController>>();
  readonly #processSlots = new Set<string>();
  readonly #agentLanes = new Map<string, Promise<void>>();
  readonly #sendLanes = new Map<string, Promise<void>>();
  readonly #compactingAgents = new Set<string>();
  readonly #destroyingAgents = new Set<string>();
  readonly #launcher: PiLauncher | undefined;
  readonly #now: () => string;
  readonly #limits: RuntimeLimits;

  constructor(
    private readonly store: FleetStore,
    options: FleetServiceOptions | (() => string) = {},
  ) {
    this.#launcher = typeof options === "function" ? undefined : options.launcher;
    this.#now =
      typeof options === "function" ? options : (options.now ?? (() => new Date().toISOString()));
    this.#limits = {
      ...DEFAULT_RUNTIME_LIMITS,
      ...(typeof options === "function" ? {} : options.limits),
    };
  }

  create(input: CreateInput, operationId: string): Promise<Result<CreateResult, FleetClientError>> {
    return this.#runOperation(operationId, "create", input, () =>
      this.#enqueueAgent(input.name, () => this.#createImpl(input, operationId)),
    );
  }

  async #createImpl(
    input: CreateInput,
    operationId: string,
  ): Promise<Result<CreateResult, FleetClientError>> {
    const replay = await this.#operation<CreateResult>(operationId, "create", input);
    if (replay !== null) return replay;
    let profile: ReturnType<typeof createLaunchProfile>;
    try {
      profile = createLaunchProfile({
        cwd: input.cwd,
        piArgv: input.piArgv,
        piArtifactId: this.#launcher?.artifactId ?? "fake-pi",
      });
    } catch (error: unknown) {
      const result = err<FleetClientError>({
        code: "invalid_arguments",
        message: error instanceof Error ? error.message : "Invalid Pi startup arguments.",
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }
    if (
      input.instructions !== undefined &&
      Buffer.byteLength(input.instructions, "utf8") > this.#limits.maxMessageBytes
    ) {
      const result = err<FleetClientError>({
        code: "invalid_arguments",
        message: `Initial instructions exceed the ${String(this.#limits.maxMessageBytes)} byte limit.`,
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }
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
      await this.#remember(operationId, "create", input, result);
      return result;
    }
    await this.#recordOperationTarget(operationId, agent);

    if (this.#launcher !== undefined && this.#reserveProcessSlot(input.name) !== "acquired") {
      await this.store.deleteAgent(input.name);
      const result = err<FleetClientError>({
        code: "capacity_exceeded",
        message: `pi-fleet has reached its ${String(this.#limits.maxResidentProcesses)} process limit.`,
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }

    let incarnationId: string | null = null;
    try {
      if (this.#launcher !== undefined) {
        incarnationId = randomUUID();
        await this.store.putIncarnation({
          incarnationId,
          agentName: input.name,
          pid: null,
          state: "starting",
        });
        const process = await this.#launcher.start(profile, false, async (pid) => {
          await this.store.putIncarnation({
            incarnationId: incarnationId!,
            agentName: input.name,
            pid,
            state: "starting",
          });
        });
        await this.store.putIncarnation({
          incarnationId,
          agentName: input.name,
          pid: process.pid,
          state: "live",
        });
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
        const coordinator = this.#attachCoordinator(agent, process, incarnationId);
        if (input.instructions !== undefined) {
          const acceptedAt = this.#now();
          const sendId = `${operationId}:initial`;
          const ordinal = await this.store.nextSendOrdinal(input.name);
          await this.store.putSend({
            sendId,
            agentName: input.name,
            ordinal,
            message: input.instructions,
            state: "pending",
            acceptedAt,
          });
          await this.store.putSend({
            sendId,
            agentName: input.name,
            ordinal,
            message: input.instructions,
            state: "dispatching",
            acceptedAt,
          });
          try {
            await this.#enqueueSend(input.name, () => coordinator.send(input.instructions!));
            await this.store.putSend({
              sendId,
              agentName: input.name,
              ordinal,
              message: input.instructions,
              state: "acknowledged",
              acceptedAt,
            });
          } catch (error: unknown) {
            await this.store.putSend({
              sendId,
              agentName: input.name,
              ordinal,
              message: input.instructions,
              state: "uncertain",
              acceptedAt,
            });
            agent = {
              ...coordinator.storedAgent,
              summary: {
                ...coordinator.storedAgent.summary,
                state: "failed",
                error: { code: "delivery_uncertain" },
              },
            };
            await this.store.putAgent(agent);
            throw error;
          }
        }
        agent = coordinator.storedAgent;
      }

      const result = ok<CreateResult>({
        schemaVersion: 1,
        type: "agent.created",
        agent: agent.summary,
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    } catch (error: unknown) {
      const coordinator = this.#coordinators.get(input.name);
      const deliveryAmbiguous =
        (await this.store.getSend(`${operationId}:initial`))?.state === "uncertain";
      let cleanupUncertain = error instanceof PiCleanupUncertainError;
      if (coordinator !== undefined) {
        try {
          await coordinator.stop("runtime_shutdown");
        } catch {
          cleanupUncertain = true;
        }
      }
      this.#coordinators.delete(input.name);
      if (cleanupUncertain) {
        agent = {
          ...agent,
          summary: {
            ...agent.summary,
            state: "failed",
            process: { state: "cleanup_uncertain" },
            error: { code: "incarnation_cleanup_uncertain" },
          },
        };
        await this.store.putAgent(agent);
      } else if (deliveryAmbiguous) {
        agent = {
          ...agent,
          summary: {
            ...agent.summary,
            state: "failed",
            process: { state: "absent" },
            error: { code: "delivery_uncertain" },
          },
        };
        await this.store.putAgent(agent);
        this.#releaseProcessSlot(input.name);
      } else {
        if (incarnationId !== null) {
          await this.store.putIncarnation({
            incarnationId,
            agentName: input.name,
            pid: error instanceof PiCleanupUncertainError ? error.pid : null,
            state: "gone",
          });
        }
        this.#releaseProcessSlot(input.name);
        await this.store.deleteAgent(input.name);
      }
      const code = cleanupUncertain
        ? "incarnation_cleanup_uncertain"
        : deliveryAmbiguous
          ? "delivery_uncertain"
          : "pi_start_failed";
      const result = err<FleetClientError>({
        code,
        message:
          code === "delivery_uncertain"
            ? "Pi may have accepted the initial instructions; pi-fleet will not replay them automatically."
            : code === "incarnation_cleanup_uncertain"
              ? "pi-fleet could not prove the Pi process group was removed."
              : "Pi failed to start.",
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }
  }

  send(input: SendInput, operationId: string): Promise<Result<SendResult, FleetClientError>> {
    return this.#runOperation(operationId, "send", input, () =>
      this.#enqueueAgent(input.name, () => this.#sendImpl(input, operationId)),
    );
  }

  async #sendImpl(
    input: SendInput,
    operationId: string,
  ): Promise<Result<SendResult, FleetClientError>> {
    const replay = await this.#operation<SendResult>(operationId, "send", input);
    if (replay !== null) return replay;
    if (this.#destroyingAgents.has(input.name)) {
      const result = err<FleetClientError>({
        code: "agent_destroying",
        message: `Agent ${input.name} is being destroyed.`,
      });
      await this.#remember(operationId, "send", input, result);
      return result;
    }
    if (Buffer.byteLength(input.message, "utf8") > this.#limits.maxMessageBytes) {
      const result = err<FleetClientError>({
        code: "invalid_arguments",
        message: `Message exceeds the ${String(this.#limits.maxMessageBytes)} byte limit.`,
      });
      await this.#remember(operationId, "send", input, result);
      return result;
    }
    const agent = await this.store.getAgent(input.name);
    if (agent === null) return this.#rememberNotFound(operationId, "send", input);
    if (agent.summary.process.state === "cleanup_uncertain") {
      const result = err<FleetClientError>({
        code: "incarnation_cleanup_uncertain",
        message: `pi-fleet cannot prove the previous process for ${input.name} is gone.`,
      });
      await this.#remember(operationId, "send", input, result);
      return result;
    }

    const acceptedAt = this.#now();
    const result = await this.#enqueueSend(input.name, async () => {
      const ordinal = await this.store.nextSendOrdinal(input.name);
      await this.store.putSend({
        sendId: operationId,
        agentName: input.name,
        ordinal,
        message: input.message,
        state: "pending",
        acceptedAt,
      });
      return this.#dispatchSend(input, operationId, acceptedAt, agent, ordinal);
    });
    await this.#remember(operationId, "send", input, result);
    return result;
  }

  compact(
    input: CompactInput,
    operationId: string,
  ): Promise<Result<CompactResult, FleetClientError>> {
    return this.#runOperation(operationId, "compact", input, () =>
      this.#enqueueAgent(input.name, () => this.#compactImpl(input, operationId)),
    );
  }

  async #compactImpl(
    input: CompactInput,
    operationId: string,
  ): Promise<Result<CompactResult, FleetClientError>> {
    const replay = await this.#operation<CompactResult>(operationId, "compact", input);
    if (replay !== null) return replay;
    const requestedAt = this.#now();
    let agent = await this.store.getAgent(input.name);
    if (agent === null) {
      return this.#rememberCompactFailure(operationId, input, requestedAt, {
        code: "agent_not_found",
        message: `Agent ${input.name} was not found.`,
      });
    }
    await this.#recordOperationTarget(operationId, agent);
    if (agent.summary.process.state === "cleanup_uncertain") {
      return this.#rememberCompactFailure(operationId, input, requestedAt, {
        code: "incarnation_cleanup_uncertain",
        message: `pi-fleet cannot prove the previous process for ${input.name} is gone.`,
      });
    }
    if (agent.summary.state !== "idle") {
      return this.#rememberCompactFailure(operationId, input, requestedAt, {
        code: "agent_busy",
        message: `Agent ${input.name} must be idle before compaction.`,
      });
    }

    await this.store.putCompact({
      compactId: operationId,
      agentName: input.name,
      state: "pending",
      requestedAt,
    });

    let coordinator: AgentCoordinator | undefined;
    try {
      coordinator = await this.#ensureResidentForCompact(agent);
      agent = coordinator?.storedAgent ?? agent;
      const nativeCompaction = coordinator !== undefined;
      if (nativeCompaction) this.#compactingAgents.add(input.name);
      let compaction: CompactResult["compaction"];
      try {
        await this.store.putCompact({
          compactId: operationId,
          agentName: input.name,
          state: "dispatching",
          requestedAt,
        });
        if (coordinator === undefined && this.#launcher === undefined) {
          compaction = { tokensBefore: 0, estimatedTokensAfter: 0 };
        } else {
          if (coordinator === undefined) throw new Error("Pi is unavailable for compaction");
          compaction = await coordinator.compact();
        }
      } finally {
        if (nativeCompaction) this.#compactingAgents.delete(input.name);
      }
      await this.store.putCompact({
        compactId: operationId,
        agentName: input.name,
        state: "completed",
        requestedAt,
        result: compaction,
      });
      const result = ok<CompactResult>({
        schemaVersion: 1,
        type: "agent.compacted",
        agent: { id: agent.summary.id, name: agent.summary.name },
        compaction,
      });
      await this.#remember(operationId, "compact", input, result);
      return result;
    } catch (error: unknown) {
      const compact = await this.store.getCompact(operationId);
      if (compact?.state === "completed" && compact.result !== undefined) {
        const result = ok<CompactResult>({
          schemaVersion: 1,
          type: "agent.compacted",
          agent: { id: agent.summary.id, name: agent.summary.name },
          compaction: compact.result,
        });
        await this.#remember(operationId, "compact", input, result);
        return result;
      }
      const message = error instanceof Error ? error.message : "Pi compaction failed";
      const busy = message === "Agent is busy";
      const preDispatch = compact?.state === "pending";
      const capacity = message === "Process capacity exceeded";
      const compactionError = error instanceof PiCompactionError ? error.code : null;
      const uncertain = !busy && !preDispatch && compactionError === null;
      if (uncertain && coordinator !== undefined && !this.#destroyingAgents.has(input.name)) {
        await coordinator.stop("runtime_shutdown").catch(() => undefined);
      }
      const cleanupUncertain =
        (await this.store.getAgent(input.name))?.summary.process.state === "cleanup_uncertain";
      const failure: FleetClientError = {
        code: busy
          ? "agent_busy"
          : capacity
            ? "capacity_exceeded"
            : cleanupUncertain
              ? "incarnation_cleanup_uncertain"
              : preDispatch
                ? "pi_start_failed"
                : (compactionError ?? "compaction_uncertain"),
        message: busy
          ? `Agent ${input.name} must be idle before compaction.`
          : capacity
            ? `pi-fleet has reached its ${String(this.#limits.maxResidentProcesses)} process limit.`
            : cleanupUncertain
              ? `pi-fleet could not prove the failed Pi restoration for ${input.name} was removed.`
              : preDispatch
                ? `Pi failed to restore for ${input.name}; compaction was not dispatched.`
                : compactionError === "nothing_to_compact"
                  ? `Agent ${input.name} has nothing to compact.`
                  : compactionError === "compaction_failed"
                    ? "Pi compaction failed."
                    : "Pi may have started compaction; pi-fleet will not replay it automatically.",
      };
      const result = err(failure);
      const terminalFailure = busy || preDispatch || compactionError !== null;
      await this.store.putCompact({
        compactId: operationId,
        agentName: input.name,
        state: terminalFailure ? "failed" : "uncertain",
        requestedAt,
        ...(terminalFailure ? { error: failure } : {}),
      });
      await this.#remember(operationId, "compact", input, result);
      return result;
    }
  }

  async #ensureResidentForCompact(agent: StoredAgent): Promise<AgentCoordinator | undefined> {
    let coordinator = this.#coordinators.get(agent.summary.name);
    if (coordinator !== undefined || this.#launcher === undefined) return coordinator;
    const reservation = this.#reserveProcessSlot(agent.summary.name);
    if (reservation === "full") {
      throw new Error("Process capacity exceeded");
    }
    if (reservation === "existing") {
      coordinator = await this.#waitForCoordinator(agent.summary.name);
      if (coordinator === undefined)
        throw new Error("Pi restoration did not produce a live process");
      return coordinator;
    }

    const restoring = await this.#markRestoring(agent);
    const incarnationId = randomUUID();
    let process: PiProcess | null = null;
    try {
      await this.store.putIncarnation({
        incarnationId,
        agentName: agent.summary.name,
        pid: null,
        state: "starting",
      });
      process = await this.#launcher.start(restoring.launch, true, async (pid) => {
        await this.store.putIncarnation({
          incarnationId,
          agentName: agent.summary.name,
          pid,
          state: "starting",
        });
      });
      await this.store.putIncarnation({
        incarnationId,
        agentName: agent.summary.name,
        pid: process.pid,
        state: "live",
      });
      const state = await process.getState();
      const restored: StoredAgent = {
        ...restoring,
        launch: observeSession(restoring.launch, {
          path: state.sessionFile ?? null,
          id: state.sessionId,
        }),
        summary: {
          ...restoring.summary,
          state: "idle",
          process: { state: "resident" },
          session: { path: state.sessionFile ?? null, id: state.sessionId },
          error: undefined,
        },
      };
      await this.store.putAgent(restored);
      return this.#attachCoordinator(restored, process, incarnationId);
    } catch (error: unknown) {
      let cleanupUncertain = error instanceof PiCleanupUncertainError;
      let pid = error instanceof PiCleanupUncertainError ? error.pid : null;
      if (process !== null) {
        pid = process.pid;
        try {
          await process.stop();
        } catch {
          cleanupUncertain = true;
        }
      }
      await this.store.putAgent({
        ...restoring,
        summary: {
          ...restoring.summary,
          state: "failed",
          process: { state: cleanupUncertain ? "cleanup_uncertain" : "absent" },
          error: { code: cleanupUncertain ? "incarnation_cleanup_uncertain" : "pi_start_failed" },
        },
      });
      await this.store.putIncarnation({
        incarnationId,
        agentName: agent.summary.name,
        pid,
        state: cleanupUncertain ? "cleanup_uncertain" : "gone",
      });
      if (!cleanupUncertain) this.#releaseProcessSlot(agent.summary.name);
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    const nonterminalCompacts = await this.store.listNonterminalCompacts();
    const nonterminalSends = await this.store.listNonterminalSends();
    const activeWorkAgents = new Set([
      ...nonterminalSends.map((send) => send.agentName),
      ...nonterminalCompacts
        .filter((compact) => compact.state === "dispatching")
        .map((compact) => compact.agentName),
    ]);
    for (const incarnation of await this.store.listActiveIncarnations()) {
      if (incarnation.state !== "cleanup_uncertain") continue;
      this.#processSlots.add(incarnation.agentName);
      if (incarnation.pid === null || !(await waitForProcessGroupExit(incarnation.pid))) continue;
      await this.store.putIncarnation({ ...incarnation, state: "gone" });
      this.#releaseProcessSlot(incarnation.agentName);
      const agent = await this.store.getAgent(incarnation.agentName);
      if (agent?.summary.process.state !== "cleanup_uncertain") continue;
      const interrupted =
        activeWorkAgents.has(incarnation.agentName) ||
        agent.summary.error?.code === "runtime_interrupted";
      await this.store.putAgent({
        ...agent,
        summary: {
          ...agent.summary,
          state: interrupted ? "failed" : "idle",
          process: { state: "absent" },
          error: interrupted ? { code: "runtime_interrupted" } : undefined,
        },
      });
    }

    for (const compact of nonterminalCompacts) {
      const input = { name: compact.agentName };
      if (compact.state === "dispatching") {
        const result = err<FleetClientError>({
          code: "compaction_uncertain",
          message: "Pi may have started compaction; pi-fleet will not replay it automatically.",
        });
        await this.store.putCompact({ ...compact, state: "uncertain" });
        await this.#remember(compact.compactId, "compact", input, result);
      } else {
        await this.compact(input, compact.compactId);
      }
    }

    for (const send of nonterminalSends) {
      const input = { name: send.agentName, message: send.message };
      if (send.state === "dispatching") {
        const result = err<FleetClientError>({
          code: "delivery_uncertain",
          message: `Delivery of ${send.sendId} was interrupted and will not be replayed.`,
        });
        await this.store.putSend({ ...send, state: "uncertain" });
        await this.#remember(send.sendId, "send", input, result);
        continue;
      }
      const agent = await this.store.getAgent(send.agentName);
      if (agent === null || agent.summary.process.state === "cleanup_uncertain") {
        const result = err<FleetClientError>({
          code: agent === null ? "agent_not_found" : "incarnation_cleanup_uncertain",
          message:
            agent === null
              ? `Agent ${send.agentName} was not found.`
              : `pi-fleet cannot prove the previous process for ${send.agentName} is gone.`,
        });
        await this.store.putSend({ ...send, state: "failed" });
        await this.#remember(send.sendId, "send", input, result);
        continue;
      }
      const result = await this.#enqueueSend(send.agentName, async () => {
        const ordinal = send.ordinal ?? (await this.store.nextSendOrdinal(send.agentName));
        return this.#dispatchSend(input, send.sendId, send.acceptedAt, agent, ordinal);
      });
      await this.#remember(send.sendId, "send", input, result);
    }

    for (const operation of await this.store.listPendingOperations()) {
      if (operation.method === "send") continue;
      const payload = JSON.parse(operation.fingerprint) as CreateInput | DestroyInput;
      if (operation.method === "create") {
        await this.create(payload as CreateInput, operation.operationId);
      } else if (operation.method === "destroy") {
        await this.destroy(payload as DestroyInput, operation.operationId);
      } else if (operation.method === "compact") {
        await this.compact(payload as CompactInput, operation.operationId);
      }
    }
  }

  async receive(
    input: ReceiveInput,
    signal?: AbortSignal,
  ): Promise<Result<ReceiveResult, FleetClientError>> {
    const coordinator = this.#coordinators.get(input.name);
    let agent: StoredAgent | null;
    try {
      agent =
        coordinator === undefined
          ? await this.store.getAgent(input.name)
          : await coordinator.waitForIdle(signal);
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      if (error instanceof Error && error.message === "Agent destroyed") {
        return err({ code: "agent_destroyed", message: `Agent ${input.name} was destroyed.` });
      }
      if (error instanceof Error && error.message === "Pi work was interrupted") {
        return err({
          code: "runtime_interrupted",
          message: `Agent ${input.name} was interrupted before becoming idle.`,
        });
      }
      throw error;
    }
    if (agent === null) return this.#notFound(input.name);
    if (agent.summary.state === "failed") {
      const code = agent.summary.error?.code ?? "agent_failed";
      return err({
        code,
        message: `Agent ${input.name} is failed (${code}) and has no current successful response.`,
      });
    }
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
    if (this.#watcherCount() >= this.#limits.maxWatchers) {
      return err({
        code: "capacity_exceeded",
        message: `pi-fleet has reached its ${String(this.#limits.maxWatchers)} watcher limit.`,
      });
    }

    const abort = new AbortController();
    const onConnectionAbort = () => abort.abort();
    connectionSignal.addEventListener("abort", onConnectionAbort, { once: true });
    const watchers = this.#watchers.get(input.name) ?? new Set<AbortController>();
    watchers.add(abort);
    this.#watchers.set(input.name, watchers);
    const subscription = new SessionTailSubscription(sessionPath, {
      signal: abort.signal,
      maxRecordBytes: this.#limits.maxSessionRecordBytes,
    });
    const cleanup = () => {
      connectionSignal.removeEventListener("abort", onConnectionAbort);
      watchers.delete(abort);
      if (watchers.size === 0) this.#watchers.delete(input.name);
    };
    return ok(watchWithCleanup(subscription, cleanup));
  }

  destroy(
    input: DestroyInput,
    operationId: string,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    return this.#runOperation(operationId, "destroy", input, async () => {
      this.#destroyingAgents.add(input.name);
      try {
        if (this.#compactingAgents.has(input.name)) {
          const replay = await this.#operation<DestroyResult>(operationId, "destroy", input);
          if (replay !== null) return replay;
          const agent = await this.store.getAgent(input.name);
          if (agent !== null) await this.#recordOperationTarget(operationId, agent);
        }
        if (this.#compactingAgents.has(input.name)) {
          await this.#coordinators
            .get(input.name)
            ?.stop("destroy")
            .catch(() => undefined);
        }
        return await this.#enqueueAgent(input.name, () => this.#destroyImpl(input, operationId));
      } finally {
        this.#destroyingAgents.delete(input.name);
      }
    });
  }

  async #destroyImpl(
    input: DestroyInput,
    operationId: string,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    const replay = await this.#operation<DestroyResult>(operationId, "destroy", input);
    if (replay !== null) return replay;
    const stored = await this.store.getAgent(input.name);
    if (stored?.summary.process.state === "cleanup_uncertain") {
      const result = err<FleetClientError>({
        code: "destroy_incomplete",
        message: `pi-fleet cannot destroy ${input.name} until its previous process is proven gone.`,
      });
      await this.#remember(operationId, "destroy", input, result);
      return result;
    }
    if (stored !== null) await this.#recordOperationTarget(operationId, stored);
    for (const watcher of this.#watchers.get(input.name) ?? []) watcher.abort();
    this.#watchers.delete(input.name);
    const coordinator = this.#coordinators.get(input.name);
    if (coordinator !== undefined) await coordinator.stop("destroy");
    this.#coordinators.delete(input.name);
    const agent = await this.store.deleteAgent(input.name);
    if (agent === null) return this.#rememberNotFound(operationId, "destroy", input);
    const result = ok<DestroyResult>({
      schemaVersion: 1,
      type: "agent.destroyed",
      agent: { id: agent.summary.id, name: agent.summary.name },
    });
    await this.#remember(operationId, "destroy", input, result);
    return result;
  }

  async releaseAgentProcess(name: string): Promise<void> {
    const coordinator = this.#coordinators.get(name);
    if (coordinator === undefined) return;
    await coordinator.stop("idle_release");
    this.#coordinators.delete(name);
  }

  async close(): Promise<void> {
    for (const watchers of this.#watchers.values()) {
      for (const watcher of watchers) watcher.abort();
    }
    this.#watchers.clear();
    await Promise.all(
      [...this.#coordinators.values()].map((coordinator) => coordinator.stop("runtime_shutdown")),
    );
    this.#coordinators.clear();
  }

  async #dispatchSend(
    input: SendInput,
    operationId: string,
    acceptedAt: string,
    initialAgent: StoredAgent,
    ordinal: number,
  ): Promise<Result<SendResult, FleetClientError>> {
    let agent = initialAgent;
    let incarnationId: string | null = null;
    let startingProcess: PiProcess | null = null;
    let restoring = false;
    try {
      let coordinator = this.#coordinators.get(input.name);
      if (this.#launcher !== undefined && coordinator === undefined) {
        const reservation = this.#reserveProcessSlot(input.name);
        if (reservation === "existing") {
          coordinator = await this.#waitForCoordinator(input.name);
          if (coordinator === undefined) {
            throw new Error(`Restoration of ${input.name} did not produce a live Pi process.`);
          }
          agent = coordinator.storedAgent;
        } else if (reservation === "full") {
          await this.store.putSend({
            sendId: operationId,
            agentName: input.name,
            ordinal,
            message: input.message,
            state: "failed",
            acceptedAt,
          });
          return err({
            code: "capacity_exceeded",
            message: `pi-fleet has reached its ${String(this.#limits.maxResidentProcesses)} process limit.`,
          });
        } else {
          restoring = true;
          agent = await this.#markRestoring(agent);
          incarnationId = randomUUID();
          await this.store.putIncarnation({
            incarnationId,
            agentName: input.name,
            pid: null,
            state: "starting",
          });
          startingProcess = await this.#launcher.start(agent.launch, true, async (pid) => {
            await this.store.putIncarnation({
              incarnationId: incarnationId!,
              agentName: input.name,
              pid,
              state: "starting",
            });
          });
          const process = startingProcess;
          await this.store.putIncarnation({
            incarnationId,
            agentName: input.name,
            pid: process.pid,
            state: "live",
          });
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
              error: undefined,
            },
          };
          await this.store.putAgent(agent);
          coordinator = this.#attachCoordinator(agent, process, incarnationId);
          restoring = false;
        }
      }

      await this.store.putSend({
        sendId: operationId,
        agentName: input.name,
        ordinal,
        message: input.message,
        state: "dispatching",
        acceptedAt,
      });
      if (coordinator === undefined) {
        await this.store.putAgent({
          ...agent,
          latestAssistantText: `Fake response to: ${input.message}`,
          responseObservedAt: acceptedAt,
        });
      } else {
        await coordinator.send(input.message);
      }
      await this.store.putSend({
        sendId: operationId,
        agentName: input.name,
        ordinal,
        message: input.message,
        state: "acknowledged",
        acceptedAt,
      });
      return ok({
        schemaVersion: 1,
        type: "message.accepted",
        agent: { id: agent.summary.id, name: agent.summary.name },
        acceptedAt,
      });
    } catch (error: unknown) {
      if (restoring && incarnationId !== null) {
        let cleanupUncertain = error instanceof PiCleanupUncertainError;
        let cleanupPid = error instanceof PiCleanupUncertainError ? error.pid : null;
        if (startingProcess !== null) {
          cleanupPid = startingProcess.pid;
          try {
            await startingProcess.stop();
          } catch {
            cleanupUncertain = true;
          }
        }
        const code = cleanupUncertain ? "incarnation_cleanup_uncertain" : "pi_start_failed";
        agent = {
          ...agent,
          summary: {
            ...agent.summary,
            state: "failed",
            process: { state: cleanupUncertain ? "cleanup_uncertain" : "absent" },
            error: { code },
          },
        };
        await this.store.putAgent(agent);
        await this.store.putIncarnation({
          incarnationId,
          agentName: input.name,
          pid: cleanupPid,
          state: cleanupUncertain ? "cleanup_uncertain" : "gone",
        });
        await this.store.putSend({
          sendId: operationId,
          agentName: input.name,
          ordinal,
          message: input.message,
          state: "failed",
          acceptedAt,
        });
        if (!cleanupUncertain) this.#releaseProcessSlot(input.name);
        return err({
          code,
          message: cleanupUncertain
            ? `pi-fleet could not prove the failed Pi restoration for ${input.name} was removed.`
            : `Pi failed to restore for ${input.name}; the message was not dispatched.`,
        });
      }

      if (!this.#coordinators.has(input.name)) this.#releaseProcessSlot(input.name);
      if (incarnationId !== null && !this.#coordinators.has(input.name)) {
        await this.store.putIncarnation({
          incarnationId,
          agentName: input.name,
          pid: null,
          state: "cleanup_uncertain",
        });
      }
      await this.store.putSend({
        sendId: operationId,
        agentName: input.name,
        ordinal,
        message: input.message,
        state: "uncertain",
        acceptedAt,
      });
      return err({
        code: "delivery_uncertain",
        message: "Pi may have accepted the message; pi-fleet will not replay it automatically.",
      });
    }
  }

  async #markRestoring(agent: StoredAgent): Promise<StoredAgent> {
    const restoring: StoredAgent = {
      ...agent,
      summary: { ...agent.summary, state: "restoring", process: { state: "starting" } },
    };
    await this.store.putAgent(restoring);
    return restoring;
  }

  #attachCoordinator(
    agent: StoredAgent,
    process: PiProcess,
    incarnationId: string,
  ): AgentCoordinator {
    const coordinator = new AgentCoordinator(
      this.store,
      agent,
      process,
      incarnationId,
      this.#now,
      () => {
        if (this.#coordinators.get(agent.summary.name) === coordinator) {
          this.#coordinators.delete(agent.summary.name);
          this.#releaseProcessSlot(agent.summary.name);
        }
      },
    );
    this.#coordinators.set(agent.summary.name, coordinator);
    return coordinator;
  }

  #enqueueAgent<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return enqueueNamed(this.#agentLanes, name, operation);
  }

  #enqueueSend<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sendLanes.get(name) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#sendLanes.set(name, settled);
    void settled.finally(() => {
      if (this.#sendLanes.get(name) === settled) this.#sendLanes.delete(name);
    });
    return result;
  }

  async #waitForCoordinator(
    name: string,
    timeoutMs = 15_000,
  ): Promise<AgentCoordinator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const coordinator = this.#coordinators.get(name);
      if (coordinator !== undefined) return coordinator;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.#coordinators.get(name);
  }

  #reserveProcessSlot(name: string): "acquired" | "existing" | "full" {
    if (this.#processSlots.has(name)) return "existing";
    if (this.#processSlots.size >= this.#limits.maxResidentProcesses) return "full";
    this.#processSlots.add(name);
    return "acquired";
  }

  #releaseProcessSlot(name: string): void {
    this.#processSlots.delete(name);
  }

  #watcherCount(): number {
    let count = 0;
    for (const watchers of this.#watchers.values()) count += watchers.size;
    return count;
  }

  #notFound<T>(name: string): Result<T, FleetClientError> {
    return err({ code: "agent_not_found", message: `Agent ${name} was not found.` });
  }

  async #rememberCompactFailure(
    operationId: string,
    input: CompactInput,
    requestedAt: string,
    failure: FleetClientError,
  ): Promise<Result<CompactResult, FleetClientError>> {
    await this.store.putCompact({
      compactId: operationId,
      agentName: input.name,
      state: "failed",
      requestedAt,
      error: failure,
    });
    const result: Result<CompactResult, FleetClientError> = err(failure);
    await this.#remember(operationId, "compact", input, result);
    return result;
  }

  async #rememberNotFound<T>(
    operationId: string,
    method: "send" | "destroy" | "compact",
    payload: object,
  ): Promise<Result<T, FleetClientError>> {
    const result = this.#notFound<T>(String("name" in payload ? payload.name : "unknown"));
    await this.#remember(operationId, method, payload, result);
    return result;
  }

  #runOperation<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
    operation: () => Promise<Result<T, FleetClientError>>,
  ): Promise<Result<T, FleetClientError>> {
    const fingerprint = JSON.stringify(payload);
    const inflight = this.#inflightOperations.get(operationId);
    if (inflight !== undefined) {
      if (inflight.method !== method || inflight.fingerprint !== fingerprint) {
        return Promise.resolve(
          err({
            code: "operation_conflict",
            message: `Operation ${operationId} was already used with a different request.`,
          }),
        );
      }
      return inflight.promise as Promise<Result<T, FleetClientError>>;
    }
    const promise = operation();
    this.#inflightOperations.set(operationId, {
      method,
      fingerprint,
      promise: promise as Promise<Result<unknown, FleetClientError>>,
    });
    void promise.then(
      () => this.#inflightOperations.delete(operationId),
      () => this.#inflightOperations.delete(operationId),
    );
    return promise;
  }

  async #operation<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
  ): Promise<Result<T, FleetClientError> | null> {
    const cached = this.#operations.get(operationId);
    const stored = cached === undefined ? await this.store.getOperation(operationId) : null;
    const recorded =
      cached ??
      (stored?.state === "completed" && stored.result !== null
        ? {
            method: stored.method,
            fingerprint: stored.fingerprint,
            result: stored.result as Result<unknown, FleetClientError>,
          }
        : undefined);
    if (recorded === undefined) {
      const fingerprint = JSON.stringify(payload);
      if (stored !== null) {
        if (stored.method !== method || stored.fingerprint !== fingerprint) {
          return err({
            code: "operation_conflict",
            message: `Operation ${operationId} was already used with a different request.`,
          });
        }
        const name = "name" in payload ? String(payload.name) : "";
        const agent = name.length === 0 ? null : await this.store.getAgent(name);
        if (method === "create") {
          if (agent === null) {
            await this.store.deleteOperation(operationId);
          } else if (agent.summary.state === "idle" || agent.summary.state === "working") {
            const result = ok<CreateResult>({
              schemaVersion: 1,
              type: "agent.created",
              agent: agent.summary,
            });
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          } else if (agent.summary.state === "failed") {
            const result = err<FleetClientError>({
              code: agent.summary.error?.code ?? "pi_start_failed",
              message: `Creation of ${name} did not complete safely.`,
            });
            await this.#remember(operationId, method, payload, result);
            return result;
          } else {
            return err({
              code: "operation_in_progress",
              message: `Operation ${operationId} is still pending.`,
            });
          }
        } else if (method === "destroy") {
          if (agent === null && stored.targetAgent !== undefined) {
            const result = ok<DestroyResult>({
              schemaVersion: 1,
              type: "agent.destroyed",
              agent: stored.targetAgent,
            });
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
          // Resume the singular destroy operation against the surviving agent.
          return null;
        } else if (method === "send") {
          const send = await this.store.getSend(operationId);
          if (send === null) {
            // The operation exists but no send record was committed, so Pi could not have been
            // dispatched. Retrying from the beginning is safe.
            await this.store.deleteOperation(operationId);
            await this.store.putOperation({
              operationId,
              method,
              fingerprint,
              state: "pending",
              result: null,
            });
            return null;
          }
          return err({
            code: "operation_in_progress",
            message: `Operation ${operationId} is still pending.`,
          });
        } else {
          const compact = await this.store.getCompact(operationId);
          if (compact?.state === "completed" && compact.result !== undefined) {
            const target = stored.targetAgent;
            if (target === undefined) {
              return err({ code: "state_corrupt", message: "Compaction target is missing." });
            }
            const result = ok<CompactResult>({
              schemaVersion: 1,
              type: "agent.compacted",
              agent: target,
              compaction: compact.result,
            });
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
          if (compact?.state === "failed" && compact.error !== undefined) {
            const result = err<FleetClientError>(compact.error);
            await this.#remember(operationId, method, payload, result);
            return result;
          }
          if (compact?.state === "dispatching" || compact?.state === "uncertain") {
            const result = err<FleetClientError>({
              code: "compaction_uncertain",
              message: "Pi may have started compaction; pi-fleet will not replay it automatically.",
            });
            await this.#remember(operationId, method, payload, result);
            return result;
          }
          if (
            stored.targetAgent !== undefined &&
            (agent === null || agent.summary.id !== stored.targetAgent.id)
          ) {
            const result = err<FleetClientError>({
              code: "agent_not_found",
              message: `The agent targeted by operation ${operationId} no longer exists.`,
            });
            await this.#remember(operationId, method, payload, result);
            return result;
          }
          if (compact === null || compact.state === "pending") return null;
          return err({ code: "state_corrupt", message: "Compaction state is incomplete." });
        }
      }
      await this.store.putOperation({
        operationId,
        method,
        fingerprint,
        state: "pending",
        result: null,
      });
      return null;
    }
    if (recorded.method !== method || recorded.fingerprint !== JSON.stringify(payload)) {
      return err({
        code: "operation_conflict",
        message: `Operation ${operationId} was already used with a different request.`,
      });
    }
    return recorded.result as Result<T, FleetClientError>;
  }

  async #recordOperationTarget(operationId: string, agent: StoredAgent): Promise<void> {
    const operation = await this.store.getOperation(operationId);
    if (operation === null || operation.state !== "pending") return;
    await this.store.putOperation({
      ...operation,
      targetAgent: { id: agent.summary.id, name: agent.summary.name },
    });
  }

  async #remember<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
    result: Result<T, FleetClientError>,
  ): Promise<void> {
    const fingerprint = JSON.stringify(payload);
    this.#operations.set(operationId, { method, fingerprint, result });
    await this.store.putOperation({
      operationId,
      method,
      fingerprint,
      state: "completed",
      result,
    });
  }
}

function enqueueNamed<T>(
  lanes: Map<string, Promise<void>>,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lanes.get(name) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(name, settled);
  void settled.finally(() => {
    if (lanes.get(name) === settled) lanes.delete(name);
  });
  return result;
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
