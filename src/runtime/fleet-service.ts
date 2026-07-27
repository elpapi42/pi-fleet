import { createHash, randomUUID } from "node:crypto";

import type { ReceiveStart } from "../client/agent-target.js";
import { isPiFleetErrorCode } from "../client/contracts.js";
import type {
  CompactInput,
  CompactResult,
  CreateInput,
  CreateResult,
  DestroyInput,
  DestroyResult,
  FleetClientError,
  ListResult,
  SendInput,
  SendResult,
  StatusInput,
  StatusResult,
} from "../client/fleet-client.js";
import { PiExecutionUnavailableError, type PiLauncher } from "../pi/adapter.js";
import { createLaunchProfile, observeSession } from "../pi/launch-profile.js";
import { PiCleanupUncertainError, PiCompactionError, type PiProcess } from "../pi/process.js";
import { waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import {
  MANAGED_PI_RUNTIME_IDENTITY,
  samePiRuntimeIdentity,
  type PiRuntimeIdentity,
} from "../protocol/pi-identity.js";
import { err, ok, type Result } from "../shared/result.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../shared/runtime-limits.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";
import type { JournalStore } from "../store/journal-store.js";
import { AgentCoordinator } from "./agent-coordinator.js";
import type { JournalIncarnationSink, JournalRuntimeComposition } from "./journal-runtime.js";
import type { ReceiveStream } from "./receive-pager.js";
import type { AgentId, ContinuityEpoch, IncarnationId } from "./semantic-events.js";

export interface PreparedReceive {
  readonly agentId: AgentId;
  readonly stream: ReceiveStream;
  readonly idle: Promise<Result<{ readonly idleEventPosition: number }, FleetClientError>> | null;
}

interface RecordedOperation {
  readonly method: "create" | "send" | "destroy" | "compact";
  readonly fingerprint: string;
  readonly result: Result<unknown, FleetClientError>;
}

export interface FleetServiceOptions {
  readonly launcher?: PiLauncher;
  readonly now?: () => string;
  readonly limits?: Partial<RuntimeLimits>;
  readonly piIdentity?: PiRuntimeIdentity;
  readonly journal?: JournalRuntimeComposition;
  readonly journalStore?: JournalStore;
  readonly onAgentDestroyed?: (agentId: AgentId) => void;
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
  readonly #processSlots = new Set<string>();
  readonly #agentLanes = new Map<string, Promise<void>>();
  readonly #sendLanes = new Map<string, Promise<void>>();
  readonly #compactingAgents = new Set<string>();
  readonly #destroyingAgents = new Set<string>();
  readonly #launcher: PiLauncher | undefined;
  readonly #now: () => string;
  readonly #limits: RuntimeLimits;
  readonly #journal: JournalRuntimeComposition | undefined;
  readonly #journalStore: JournalStore | undefined;
  readonly #journalSinks = new Map<string, JournalIncarnationSink>();
  readonly #onAgentDestroyed: (agentId: AgentId) => void;
  readonly #piIdentity: PiRuntimeIdentity;
  #storageFailure: Error | null = null;
  #closing = false;

  constructor(
    private readonly store: FleetStore,
    options: FleetServiceOptions | (() => string) = {},
  ) {
    this.#launcher = typeof options === "function" ? undefined : options.launcher;
    this.#now =
      typeof options === "function" ? options : (options.now ?? (() => new Date().toISOString()));
    this.#piIdentity =
      typeof options === "function"
        ? MANAGED_PI_RUNTIME_IDENTITY
        : (options.piIdentity ?? MANAGED_PI_RUNTIME_IDENTITY);
    this.#limits = {
      ...DEFAULT_RUNTIME_LIMITS,
      ...(typeof options === "function" ? {} : options.limits),
    };
    this.#journal = typeof options === "function" ? undefined : options.journal;
    this.#journalStore = typeof options === "function" ? undefined : options.journalStore;
    this.#onAgentDestroyed =
      typeof options === "function"
        ? () => undefined
        : (options.onAgentDestroyed ?? (() => undefined));
  }

  failStorage(error: Error): void {
    this.#storageFailure ??= error;
    for (const coordinator of this.#coordinators.values()) {
      // Storage is already terminal: stop Pi directly instead of attempting another store write.
      void coordinator.process.stop().catch(() => undefined);
    }
  }

  failAgent(agentId: AgentId, error: Error): void {
    const coordinator = [...this.#coordinators.values()].find(
      (candidate) => candidate.storedAgent.summary.id === agentId,
    );
    if (coordinator === undefined) return;
    const agent = coordinator.storedAgent;
    void this.store
      .putAgent({
        ...agent,
        summary: {
          ...agent.summary,
          state: "failed",
          error: {
            code: error.message.includes("capacity") ? "storage_unavailable" : "state_corrupt",
          },
        },
      })
      .catch(() => undefined);
    void coordinator.process.stop().catch(() => undefined);
  }

  create(
    input: CreateInput,
    operationId: string,
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<CreateResult, FleetClientError>> {
    return this.#runOperation(operationId, "create", input, () =>
      this.#enqueueAgent(input.name, () => this.#createImpl(input, operationId, callerPiIdentity)),
    );
  }

  async #createImpl(
    input: CreateInput,
    operationId: string,
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<CreateResult, FleetClientError>> {
    if (this.#storageFailure !== null) {
      return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
    }
    const replay = await this.#operation<CreateResult>(operationId, "create", input);
    if (replay !== null) return replay;
    if (this.#closing) return this.#runtimeUnavailable();
    let profile: ReturnType<typeof createLaunchProfile>;
    try {
      profile = createLaunchProfile({
        cwd: input.cwd,
        piArgv: input.piArgv,
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
    if ((await this.store.getAgent(input.name)) !== null) {
      const result = err<FleetClientError>({
        code: "name_taken",
        message: `Agent ${input.name} already exists.`,
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }
    const identityFailure = this.#piIdentityFailure(callerPiIdentity);
    if (identityFailure !== null) {
      const result = err<FleetClientError>(identityFailure);
      await this.#remember(operationId, "create", input, result);
      return result;
    }
    const preflightFailure = await this.#piExecutionFailure();
    if (preflightFailure !== null) {
      const result = err<FleetClientError>(preflightFailure);
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
    };
    const pendingCreate = await this.store.getOperation(operationId);
    if (pendingCreate === null) throw new Error("Create operation receipt is missing");
    if (
      !(await this.store.createAgent(agent, {
        ...pendingCreate,
        targetName: input.name,
        targetAgent: { id: agent.summary.id, name: input.name },
      }))
    ) {
      const result = err<FleetClientError>({
        code: "name_taken",
        message: `Agent ${input.name} already exists.`,
      });
      await this.#remember(operationId, "create", input, result);
      return result;
    }
    if (this.#journalStore !== undefined) {
      await this.#journalStore.putEpoch({
        agentId: agent.summary.id as AgentId,
        epoch: 0 as ContinuityEpoch,
        state: "open",
        lastSafeEventPosition: 0,
        openedAt: this.#now(),
      });
    }
    await this.#recordOperationTarget(operationId, agent);

    if (this.#launcher !== undefined && this.#reserveProcessSlot(input.name) !== "acquired") {
      const result = err<FleetClientError>({
        code: "capacity_exceeded",
        message: `pi-fleet has reached its ${String(this.#limits.maxResidentProcesses)} process limit.`,
      });
      await this.#rollbackProvisionalCreate(agent, operationId, result);
      return result;
    }

    let incarnationId: string | null = null;
    try {
      if (this.#launcher !== undefined) {
        incarnationId = randomUUID();
        await this.store.putIncarnation({
          incarnationId,
          agentId: agent.summary.id,
          agentName: input.name,
          pid: null,
          state: "starting",
        });
        const journalSink = await this.#openJournalSink(agent, incarnationId);
        const process = await this.#launcher.start(
          profile,
          false,
          async (pid) => {
            await this.store.putIncarnation({
              incarnationId: incarnationId!,
              agentId: agent.summary.id,
              agentName: input.name,
              pid,
              state: "starting",
            });
          },
          journalSink?.pushRecord,
        );
        await this.store.putIncarnation({
          incarnationId,
          agentId: agent.summary.id,
          agentName: input.name,
          pid: process.pid,
          state: "live",
        });
        const state = await process.getState();
        const observedProfile = observeSession(profile, {
          path: state.sessionFile ?? null,
          id: state.sessionId,
        });
        await this.#journal?.markIdle(agent.summary.id as AgentId);
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
            agentId: agent.summary.id,
            agentName: input.name,
            ordinal,
            message: input.instructions,
            delivery: "steer",
            state: "pending",
            acceptedAt,
          });
          await this.store.putSend({
            sendId,
            agentId: agent.summary.id,
            agentName: input.name,
            ordinal,
            message: input.instructions,
            delivery: "steer",
            state: "dispatching",
            acceptedAt,
          });
          try {
            await this.#enqueueSend(input.name, async () => {
              await coordinator.send(input.instructions!);
              await coordinator.reconcileState();
            });
            await this.store.putSend({
              sendId,
              agentId: agent.summary.id,
              agentName: input.name,
              ordinal,
              message: input.instructions,
              delivery: "steer",
              state: "acknowledged",
              acceptedAt,
            });
          } catch (error: unknown) {
            await this.store.putSend({
              sendId,
              agentId: agent.summary.id,
              agentName: input.name,
              ordinal,
              message: input.instructions,
              delivery: "steer",
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
      if (incarnationId !== null && coordinator === undefined) {
        this.#finishJournalSink(incarnationId);
      }
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
            agentId: agent.summary.id,
            agentName: input.name,
            pid: error instanceof PiCleanupUncertainError ? error.pid : null,
            state: "gone",
          });
        }
        this.#releaseProcessSlot(input.name);
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
      if (cleanupUncertain || deliveryAmbiguous) {
        await this.#remember(operationId, "create", input, result);
      } else {
        await this.#rollbackProvisionalCreate(agent, operationId, result);
      }
      return result;
    }
  }

  send(
    input: SendInput,
    operationId: string,
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<SendResult, FleetClientError>> {
    const normalizedInput: SendInput = {
      ...input,
      delivery: input.delivery ?? "steer",
    };
    return this.#runOperation(operationId, "send", normalizedInput, () =>
      this.#enqueueAgent(normalizedInput.name, () =>
        this.#sendImpl(normalizedInput, operationId, callerPiIdentity),
      ),
    );
  }

  async #sendImpl(
    input: SendInput,
    operationId: string,
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<SendResult, FleetClientError>> {
    if (this.#storageFailure !== null) {
      return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
    }
    const replay = await this.#operation<SendResult>(operationId, "send", input);
    if (replay !== null) return replay;
    if (this.#closing) return this.#runtimeUnavailable();
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
    const staleTarget = this.#staleTarget<SendResult>(input.expectedAgentId, agent);
    if (staleTarget !== null) {
      await this.#remember(operationId, "send", input, staleTarget);
      return staleTarget;
    }
    await this.#recordOperationTarget(operationId, agent);
    if (agent.summary.process.state === "cleanup_uncertain") {
      const result = err<FleetClientError>({
        code: "incarnation_cleanup_uncertain",
        message: `pi-fleet cannot prove the previous process for ${input.name} is gone.`,
      });
      await this.#remember(operationId, "send", input, result);
      return result;
    }
    const identityFailure = this.#piIdentityFailure(callerPiIdentity);
    if (identityFailure !== null) {
      const result = err<FleetClientError>(identityFailure);
      await this.#remember(operationId, "send", input, result);
      return result;
    }
    const preflightFailure = await this.#piExecutionFailure();
    if (preflightFailure !== null) {
      const result = err<FleetClientError>(preflightFailure);
      await this.#remember(operationId, "send", input, result);
      return result;
    }

    const acceptedAt = this.#now();
    const result = await this.#enqueueSend(input.name, async () => {
      const ordinal = await this.store.nextSendOrdinal(input.name);
      await this.store.putSend({
        sendId: operationId,
        agentId: agent.summary.id,
        agentName: input.name,
        ordinal,
        message: input.message,
        delivery: input.delivery ?? "steer",
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
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<CompactResult, FleetClientError>> {
    return this.#runOperation(operationId, "compact", input, () =>
      this.#enqueueAgent(input.name, () => this.#compactImpl(input, operationId, callerPiIdentity)),
    );
  }

  async #compactImpl(
    input: CompactInput,
    operationId: string,
    callerPiIdentity?: PiRuntimeIdentity,
  ): Promise<Result<CompactResult, FleetClientError>> {
    if (this.#storageFailure !== null) {
      return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
    }
    const replay = await this.#operation<CompactResult>(operationId, "compact", input);
    if (replay !== null) return replay;
    if (this.#closing) return this.#runtimeUnavailable();
    const requestedAt = this.#now();
    let agent = await this.store.getAgent(input.name);
    if (agent === null) {
      return this.#rememberCompactFailure(operationId, input, requestedAt, {
        code: "agent_not_found",
        message: `Agent ${input.name} was not found.`,
      });
    }
    const staleTarget = this.#staleTarget<CompactResult>(input.expectedAgentId, agent);
    if (staleTarget !== null) {
      await this.#remember(operationId, "compact", input, staleTarget);
      return staleTarget;
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
    const identityFailure = this.#piIdentityFailure(callerPiIdentity);
    if (identityFailure !== null) {
      return this.#rememberCompactFailure(operationId, input, requestedAt, identityFailure);
    }
    const preflightFailure = await this.#piExecutionFailure();
    if (preflightFailure !== null) {
      return this.#rememberCompactFailure(operationId, input, requestedAt, preflightFailure);
    }

    await this.store.putCompact({
      compactId: operationId,
      agentId: agent.summary.id,
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
          agentId: agent.summary.id,
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
        agentId: agent.summary.id,
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
        agentId: agent.summary.id,
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
        agentId: agent.summary.id,
        agentName: agent.summary.name,
        pid: null,
        state: "starting",
      });
      const journalSink = await this.#openJournalSink(restoring, incarnationId);
      process = await this.#launcher.start(
        restoring.launch,
        true,
        async (pid) => {
          await this.store.putIncarnation({
            incarnationId,
            agentId: agent.summary.id,
            agentName: agent.summary.name,
            pid,
            state: "starting",
          });
        },
        journalSink?.pushRecord,
      );
      await this.store.putIncarnation({
        incarnationId,
        agentId: agent.summary.id,
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
      this.#finishJournalSink(incarnationId);
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
        agentId: agent.summary.id,
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
    const activeIncarnations = await this.store.listActiveIncarnations();
    const activeWorkAgents = new Set([
      ...nonterminalSends.map((send) => send.agentName),
      ...nonterminalCompacts
        .filter((compact) => compact.state === "dispatching")
        .map((compact) => compact.agentName),
    ]);
    for (const incarnation of activeIncarnations) {
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

    const piExecutionFailure = await this.#piExecutionFailure();

    for (const compact of nonterminalCompacts) {
      const input = { name: compact.agentName };
      if (compact.state === "dispatching") {
        const result = err<FleetClientError>({
          code: "compaction_uncertain",
          message: "Pi may have started compaction; pi-fleet will not replay it automatically.",
        });
        await this.store.putCompact({ ...compact, state: "uncertain" });
        await this.#remember(compact.compactId, "compact", input, result);
      } else if (piExecutionFailure === null) {
        await this.compact(input, compact.compactId);
      }
    }

    for (const send of nonterminalSends) {
      if (send.agentId === undefined) {
        throw new Error(`Durable send ${send.sendId} is missing its agent generation`);
      }
      const input: SendInput = {
        name: send.agentName,
        expectedAgentId: send.agentId,
        message: send.message,
        delivery: send.delivery ?? "steer",
      };
      if (send.state === "dispatching") {
        const result = err<FleetClientError>({
          code: "delivery_uncertain",
          message: `Delivery of ${send.sendId} was interrupted and will not be replayed.`,
        });
        await this.store.putSend({ ...send, state: "uncertain" });
        await this.#remember(send.sendId, "send", input, result);
        continue;
      }
      if (piExecutionFailure !== null) continue;
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
      const target = operation.targetAgent;
      if (operation.method === "create") {
        const agent = await this.store.getAgent(operation.targetName);
        const hasActiveIncarnation = activeIncarnations.some(
          (incarnation) => incarnation.agentId === target?.id,
        );
        const startFailed = err<FleetClientError>({
          code: "pi_start_failed",
          message: `Creation of ${operation.targetName} stopped before Pi was safely dispatched.`,
        });
        if (
          target !== undefined &&
          agent?.summary.id === target.id &&
          agent.summary.state === "restoring" &&
          !hasActiveIncarnation
        ) {
          await this.#rollbackProvisionalCreate(agent, operation.operationId, startFailed);
        } else if (target !== undefined && agent?.summary.id === target.id) {
          const result =
            agent.summary.state === "idle"
              ? ok<CreateResult>({
                  schemaVersion: 1,
                  type: "agent.created",
                  agent: agent.summary,
                })
              : err<FleetClientError>({
                  code: publicAgentFailureCode(agent.summary.error?.code, "runtime_interrupted"),
                  message: `Creation of ${operation.targetName} did not settle successfully.`,
                });
          await this.store.putOperation({ ...operation, state: "completed", result });
        } else if (target === undefined && agent === null && isCreateRequest(operation.request)) {
          // No agent row was ever committed, so creation is proven undispatched and
          // the exact retained request can resume once Pi is available again.
          if (piExecutionFailure === null)
            await this.create(operation.request, operation.operationId);
        } else {
          await this.store.putOperation({ ...operation, state: "completed", result: startFailed });
        }
      } else if (operation.method === "destroy") {
        if (target === undefined) {
          await this.store.putOperation({
            ...operation,
            state: "completed",
            result: this.#notFound(operation.targetName),
          });
        } else {
          // The bound agent name is authoritative for the durable request identity.
          await this.destroy(
            { name: target.name, expectedAgentId: target.id },
            operation.operationId,
          );
        }
      } else if (operation.method === "compact") {
        if (target === undefined) {
          await this.store.putOperation({
            ...operation,
            state: "completed",
            result: this.#notFound(operation.targetName),
          });
        } else if (piExecutionFailure === null) {
          await this.compact(
            { name: target.name, expectedAgentId: target.id },
            operation.operationId,
          );
        }
      }
    }
  }

  async status(input: StatusInput): Promise<Result<StatusResult, FleetClientError>> {
    if (this.#storageFailure !== null) {
      return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
    }
    const agent = await this.store.getAgent(input.name);
    if (agent === null) return this.#notFound(input.name);
    return (
      this.#staleTarget<StatusResult>(input.expectedAgentId, agent) ??
      ok({ schemaVersion: 1, type: "agent.status", agent: agent.summary })
    );
  }

  async list(): Promise<Result<ListResult, FleetClientError>> {
    if (this.#storageFailure !== null) {
      return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
    }
    const agents = await this.store.listAgents();
    return ok({
      schemaVersion: 1,
      type: "agent.list",
      agents: agents.map((agent) => agent.summary),
    });
  }

  async waitForIdle(
    input: StatusInput,
    signal: AbortSignal,
  ): Promise<Result<StatusResult, FleetClientError>> {
    const current = await this.status(input);
    if (!current.ok || current.value.agent.state === "idle") return current;
    if (current.value.agent.state === "failed") {
      return err({
        code: publicAgentFailureCode(current.value.agent.error?.code),
        message: `Agent ${input.name} failed before reaching idle.`,
      });
    }
    const coordinator = this.#coordinators.get(input.name);
    if (coordinator === undefined) {
      return err({ code: "state_corrupt", message: `Agent ${input.name} has no active process.` });
    }
    try {
      const boundary = await coordinator.waitForIdle(signal);
      return (
        this.#staleTarget<StatusResult>(input.expectedAgentId, boundary.agent) ??
        ok({ schemaVersion: 1, type: "agent.status", agent: boundary.agent.summary })
      );
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return err({
        code: "runtime_interrupted",
        message: `Agent ${input.name} was interrupted before becoming idle.`,
      });
    }
  }

  prepareReceive(
    input: StatusInput,
    start: ReceiveStart,
    untilIdle: boolean,
    signal: AbortSignal,
  ): Promise<Result<PreparedReceive, FleetClientError>> {
    return this.#enqueueAgent(input.name, async () => {
      if (this.#closing) return this.#runtimeUnavailable();
      if (this.#storageFailure !== null) {
        return err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." });
      }
      if (this.#journal === undefined) {
        return err({ code: "protocol_incompatible", message: "Semantic receive is unavailable." });
      }
      const agent = await this.store.getAgent(input.name);
      if (agent === null) return this.#notFound(input.name);
      const stale = this.#staleTarget<PreparedReceive>(input.expectedAgentId, agent);
      if (stale !== null) return stale;
      if (agent.summary.state === "failed") {
        return err({
          code: publicAgentFailureCode(agent.summary.error?.code),
          message: `Agent ${input.name} is failed.`,
        });
      }
      const agentId = agent.summary.id as AgentId;
      const stream = await this.#journal.openReceive(agentId, start, signal);
      if (!untilIdle) return ok({ agentId, stream, idle: null });

      const coordinator = this.#coordinators.get(input.name);
      if (coordinator !== undefined) {
        const { completion } = await coordinator.registerIdleWaiter(signal);
        const idle = completion.then(
          (boundary) => ok({ idleEventPosition: boundary.idleEventPosition }),
          () =>
            err<FleetClientError>({
              code: "runtime_interrupted",
              message: `Agent ${input.name} was interrupted before becoming idle.`,
            }),
        );
        return ok({ agentId, stream, idle });
      }
      if (agent.summary.state !== "idle") {
        return err({
          code: "state_corrupt",
          message: `Agent ${input.name} has no active process.`,
        });
      }
      const idleEventPosition =
        (await this.#journal.idleEventHighWater(agentId)) ??
        (await this.#journal.markIdle(agentId));
      return ok({
        agentId,
        stream,
        idle: Promise.resolve(ok({ idleEventPosition })),
      });
    });
  }

  destroy(
    input: DestroyInput,
    operationId: string,
  ): Promise<Result<DestroyResult, FleetClientError>> {
    if (this.#closing) return Promise.resolve(this.#runtimeUnavailable());
    if (this.#storageFailure !== null) {
      void this.#coordinators
        .get(input.name)
        ?.process.stop()
        .catch(() => undefined);
      return Promise.resolve(
        err({ code: "storage_unavailable", message: "pi-fleet storage is unavailable." }),
      );
    }
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
    if (stored !== null) {
      const staleTarget = this.#staleTarget<DestroyResult>(input.expectedAgentId, stored);
      if (staleTarget !== null) {
        await this.#remember(operationId, "destroy", input, staleTarget);
        return staleTarget;
      }
    }
    if (stored?.summary.process.state === "cleanup_uncertain") {
      const result = err<FleetClientError>({
        code: "destroy_incomplete",
        message: `pi-fleet cannot destroy ${input.name} until its previous process is proven gone.`,
      });
      await this.#remember(operationId, "destroy", input, result);
      return result;
    }
    if (stored !== null) await this.#recordOperationTarget(operationId, stored);
    const coordinator = this.#coordinators.get(input.name);
    if (coordinator !== undefined) {
      try {
        await coordinator.stop("destroy");
      } catch {
        const result = err<FleetClientError>({
          code: "destroy_incomplete",
          message: `pi-fleet could not prove the Pi process for ${input.name} was removed.`,
        });
        await this.#remember(operationId, "destroy", input, result);
        return result;
      }
    }
    this.#coordinators.delete(input.name);
    const pending = await this.store.getOperation(operationId);
    const agent = await this.store.deleteAgent(input.name, {
      operationId,
      fingerprint: pending?.fingerprint ?? JSON.stringify(input),
      destroyedAt: this.#now(),
    });
    if (agent === null) return this.#rememberNotFound(operationId, "destroy", input);
    this.#onAgentDestroyed(agent.summary.id as AgentId);
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

  beginShutdown(): void {
    this.#closing = true;
  }

  async drainStdoutAndJournal(): Promise<void> {
    await Promise.all(
      [...this.#coordinators.values()].map((coordinator) => {
        const process = coordinator.process as PiProcess & { drainStdout?: () => Promise<void> };
        return process.drainStdout?.() ?? Promise.resolve();
      }),
    );
    await this.#journal?.ingestion.drain();
  }

  async stopProcessTrees(): Promise<void> {
    const stops = await Promise.allSettled(
      [...this.#coordinators.values()].map((coordinator) => coordinator.stop("runtime_shutdown")),
    );
    this.#coordinators.clear();
    for (const incarnationId of [...this.#journalSinks.keys()]) {
      this.#finishJournalSink(incarnationId);
    }
    await this.#journal?.closeIngestion();
    const failure = stops.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.drainStdoutAndJournal();
    await this.stopProcessTrees();
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
            agentId: agent.summary.id,
            agentName: input.name,
            ordinal,
            message: input.message,
            delivery: input.delivery ?? "steer",
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
            agentId: agent.summary.id,
            agentName: input.name,
            pid: null,
            state: "starting",
          });
          const journalSink = await this.#openJournalSink(agent, incarnationId);
          startingProcess = await this.#launcher.start(
            agent.launch,
            true,
            async (pid) => {
              await this.store.putIncarnation({
                incarnationId: incarnationId!,
                agentId: agent.summary.id,
                agentName: input.name,
                pid,
                state: "starting",
              });
            },
            journalSink?.pushRecord,
          );
          const process = startingProcess;
          await this.store.putIncarnation({
            incarnationId,
            agentId: agent.summary.id,
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
        agentId: agent.summary.id,
        agentName: input.name,
        ordinal,
        message: input.message,
        delivery: input.delivery ?? "steer",
        state: "dispatching",
        acceptedAt,
      });
      if (coordinator !== undefined) {
        await coordinator.send(input.message, input.delivery ?? "steer");
        await coordinator.reconcileState();
      }
      await this.store.putSend({
        sendId: operationId,
        agentId: agent.summary.id,
        agentName: input.name,
        ordinal,
        message: input.message,
        delivery: input.delivery ?? "steer",
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
        this.#finishJournalSink(incarnationId);
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
          agentId: agent.summary.id,
          agentName: input.name,
          pid: cleanupPid,
          state: cleanupUncertain ? "cleanup_uncertain" : "gone",
        });
        await this.store.putSend({
          sendId: operationId,
          agentId: agent.summary.id,
          agentName: input.name,
          ordinal,
          message: input.message,
          delivery: input.delivery ?? "steer",
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
          agentId: agent.summary.id,
          agentName: input.name,
          pid: null,
          state: "cleanup_uncertain",
        });
      }
      await this.store.putSend({
        sendId: operationId,
        agentId: agent.summary.id,
        agentName: input.name,
        ordinal,
        message: input.message,
        delivery: input.delivery ?? "steer",
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
        this.#finishJournalSink(incarnationId);
        if (this.#coordinators.get(agent.summary.name) === coordinator) {
          this.#coordinators.delete(agent.summary.name);
          this.#releaseProcessSlot(agent.summary.name);
        }
      },
      async (idleAgent) => (await this.#journal?.markIdle(idleAgent.summary.id as AgentId)) ?? 0,
    );
    this.#coordinators.set(agent.summary.name, coordinator);
    return coordinator;
  }

  async #openJournalSink(
    agent: StoredAgent,
    incarnationId: string,
  ): Promise<JournalIncarnationSink | undefined> {
    if (this.#journal === undefined || this.#journalStore === undefined) return undefined;
    const agentId = agent.summary.id as AgentId;
    const epochs = await this.#journalStore.getEpochs(agentId);
    const last = epochs.at(-1);
    const epoch = (
      last?.state === "open" ? last.epoch : (last?.epoch ?? -1) + 1
    ) as ContinuityEpoch;
    if (last?.state !== "open") {
      await this.#journalStore.putEpoch({
        agentId,
        epoch,
        state: "open",
        lastSafeEventPosition: (await this.#journalStore.getHighWater(agentId))?.eventPosition ?? 0,
        openedAt: this.#now(),
      });
    }
    const sink = await this.#journal.openIncarnation({
      agentId,
      incarnationId: incarnationId as IncarnationId,
      epoch,
    });
    this.#journalSinks.set(incarnationId, sink);
    return sink;
  }

  #finishJournalSink(incarnationId: string): void {
    const sink = this.#journalSinks.get(incarnationId);
    if (sink === undefined) return;
    this.#journalSinks.delete(incarnationId);
    sink.finish();
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

  #staleTarget<T>(
    expectedAgentId: string | undefined,
    agent: StoredAgent,
  ): Result<T, FleetClientError> | null {
    if (expectedAgentId === undefined || expectedAgentId === agent.summary.id) return null;
    return err({
      code: "stale_agent",
      message: `Agent ${agent.summary.name} was recreated; this operation targets an older generation.`,
    });
  }

  #runtimeUnavailable<T>(): Result<T, FleetClientError> {
    return err({ code: "runtime_unavailable", message: "pi-fleet runtime is shutting down." });
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
    const agent = await this.store.getAgent(input.name);
    if (agent !== null) {
      await this.store.putCompact({
        compactId: operationId,
        agentId: agent.summary.id,
        agentName: input.name,
        state: "failed",
        requestedAt,
        error: failure,
      });
    }
    const result: Result<CompactResult, FleetClientError> = err(failure);
    await this.#remember(operationId, "compact", input, result);
    return result;
  }

  #piIdentityFailure(callerIdentity: PiRuntimeIdentity | undefined): FleetClientError | null {
    if (callerIdentity === undefined || samePiRuntimeIdentity(callerIdentity, this.#piIdentity)) {
      return null;
    }
    return {
      code: "pi_runtime_mismatch",
      message:
        "The running pi-fleet runtime uses a different Pi installation; repair or restart it.",
    };
  }

  async #piExecutionFailure(): Promise<FleetClientError | null> {
    if (this.#launcher?.preflight === undefined) return null;
    try {
      await this.#launcher.preflight();
      return null;
    } catch (error: unknown) {
      if (!(error instanceof PiExecutionUnavailableError)) throw error;
      const messages: Record<PiExecutionUnavailableError["code"], string> = {
        pi_not_found: "The selected Pi executable was not found.",
        pi_not_executable: "The selected Pi executable cannot be executed.",
        pi_version_unavailable: "The selected Pi version could not be determined.",
        pi_version_unsupported: "The selected Pi version is not supported.",
        pi_installation_changed: "The selected Pi installation changed during validation.",
      };
      return { code: error.code, message: messages[error.code] };
    }
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
    const fingerprint = fingerprintPayload(payload);
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
      const fingerprint = fingerprintPayload(payload);
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
          if (stored.targetAgent === undefined) {
            if (agent === null) return null;
            const result = err<FleetClientError>({
              code: "name_taken",
              message: `Agent ${name} already exists.`,
            });
            await this.#remember(operationId, method, payload, result);
            return result;
          }
          if (agent === null || agent.summary.id !== stored.targetAgent.id) {
            const result = err<FleetClientError>({
              code: "stale_agent",
              message: `Creation operation ${operationId} targets an unavailable agent generation.`,
            });
            await this.#remember(operationId, method, payload, result);
            return result;
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
              code: publicAgentFailureCode(agent.summary.error?.code, "pi_start_failed"),
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
          if (stored.targetAgent === undefined) {
            const result = this.#notFound<DestroyResult>(name);
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
          if (agent === null) {
            const result = ok<DestroyResult>({
              schemaVersion: 1,
              type: "agent.destroyed",
              agent: {
                id: stored.targetAgent.id,
                name: stored.targetAgent.name || String("name" in payload ? payload.name : ""),
              },
            });
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
          // Resume the singular destroy operation against the surviving agent.
          return null;
        } else if (method === "send") {
          const send = await this.store.getSend(operationId);
          if (stored.targetAgent === undefined) {
            const result = this.#notFound<SendResult>(name);
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
          if (send === null) {
            // The operation exists but no send record was committed, so Pi could not have been
            // dispatched. Retrying from the beginning is safe.
            await this.store.deleteOperation(operationId);
            await this.store.putOperation({
              operationId,
              method,
              fingerprint,
              targetName: String("name" in payload ? payload.name : ""),
              state: "pending",
              result: null,
              request: payload,
            });
            return null;
          }
          return err({
            code: "operation_in_progress",
            message: `Operation ${operationId} is still pending.`,
          });
        } else {
          const compact = await this.store.getCompact(operationId);
          if (stored.targetAgent === undefined) {
            const result = this.#notFound<CompactResult>(name);
            await this.#remember(operationId, method, payload, result);
            return result as Result<T, FleetClientError>;
          }
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
        targetName: String("name" in payload ? payload.name : ""),
        state: "pending",
        result: null,
        request: payload,
      });
      return null;
    }
    if (recorded.method !== method || recorded.fingerprint !== fingerprintPayload(payload)) {
      return err({
        code: "operation_conflict",
        message: `Operation ${operationId} was already used with a different request.`,
      });
    }
    return recorded.result as Result<T, FleetClientError>;
  }

  async #rollbackProvisionalCreate(
    agent: StoredAgent,
    operationId: string,
    result: Result<CreateResult, FleetClientError>,
  ): Promise<void> {
    const operation = await this.store.getOperation(operationId);
    if (
      operation === null ||
      operation.method !== "create" ||
      operation.state !== "pending" ||
      operation.targetAgent?.id !== agent.summary.id
    ) {
      throw new Error("Provisional create operation receipt is missing or inconsistent");
    }
    await this.store.rollbackProvisionalCreate(agent.summary.name, {
      operationId: operation.operationId,
      method: operation.method,
      fingerprint: operation.fingerprint,
      state: "completed",
      result,
      targetName: agent.summary.name,
    });
  }

  async #recordOperationTarget(operationId: string, agent: StoredAgent): Promise<void> {
    const operation = await this.store.getOperation(operationId);
    if (operation === null || operation.state !== "pending") return;
    await this.store.putOperation({
      ...operation,
      targetName: agent.summary.name,
      targetAgent: { id: agent.summary.id, name: agent.summary.name },
    });
  }

  async #remember<T>(
    operationId: string,
    method: RecordedOperation["method"],
    payload: object,
    result: Result<T, FleetClientError>,
  ): Promise<void> {
    const fingerprint = fingerprintPayload(payload);
    this.#operations.set(operationId, { method, fingerprint, result });
    const existing = await this.store.getOperation(operationId);
    await this.store.putOperation({
      operationId,
      method,
      fingerprint,
      targetName: existing?.targetName ?? String("name" in payload ? payload.name : ""),
      state: "completed",
      result,
      ...(existing?.targetAgent === undefined ? {} : { targetAgent: existing.targetAgent }),
    });
  }
}

function isCreateRequest(request: unknown): request is CreateInput {
  return (
    typeof request === "object" &&
    request !== null &&
    "name" in request &&
    typeof (request as { name: unknown }).name === "string"
  );
}

function publicAgentFailureCode(
  code: string | undefined,
  fallback: FleetClientError["code"] = "runtime_interrupted",
): FleetClientError["code"] {
  return isPiFleetErrorCode(code) ? code : fallback;
}

/**
 * Content-free durable identity for a mutation request.
 *
 * The digest excludes transport-only `expectedAgentId` so an omitted caller
 * generation and an explicitly reconstructed one share one durable identity,
 * and it retains no prompt, message, cwd, or Pi argument content.
 */
export function fingerprintPayload(payload: object): string {
  const durable = { ...(payload as Record<string, unknown>) };
  delete durable.expectedAgentId;
  const canonical = JSON.stringify(canonicalizeFingerprintValue(durable));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeFingerprintValue(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeFingerprintValue(item)]),
  );
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
