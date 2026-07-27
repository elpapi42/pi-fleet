import { observeSession } from "../pi/launch-profile.js";
import {
  PiCompactionError,
  type PiCompactionResult,
  type PiDeliveryMode,
  type PiProcess,
  type PiState,
} from "../pi/process.js";
import { waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";

export type CoordinatorStopReason = "destroy" | "runtime_shutdown" | "idle_release";

export interface IdleBoundary {
  readonly agent: StoredAgent;
  readonly idleEventPosition: number;
}

interface IdleWaiter {
  readonly resolve: (boundary: IdleBoundary) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class AgentCoordinator {
  readonly #idleWaiters = new Set<IdleWaiter>();
  #lane: Promise<void> = Promise.resolve();
  #stopReason: CoordinatorStopReason | null = null;
  #handlingFailure = false;
  #mayBeWorking = false;
  #idleEventPosition: number | null = null;
  #unsubscribeFrame: () => void;
  #unsubscribeExit: () => void;

  constructor(
    private readonly store: FleetStore,
    private agent: StoredAgent,
    readonly process: PiProcess,
    readonly incarnationId: string,
    private readonly now: () => string,
    private readonly onProcessExit: (error: Error | null) => void,
    private readonly onIdle?: (agent: StoredAgent) => Promise<number>,
  ) {
    this.#unsubscribeFrame = process.onFrame((frame) => {
      if (frame.type === "agent_start") this.#queueEvent(() => this.#markWorking());
      if (frame.type === "agent_settled") this.#queueEvent(() => this.#markIdle());
    });
    this.#unsubscribeExit = process.onExit((error) => {
      this.#queueEvent(() => this.#handleProcessExit(error));
    });
  }

  get storedAgent(): StoredAgent {
    return this.agent;
  }

  get idleEventPosition(): number | null {
    return this.#idleEventPosition;
  }

  /**
   * Delivers caller input to Pi.
   *
   * Follow-up delivery means "wait until the current run finishes", which Pi only
   * honours while a turn is active: a follow-up queued against an authoritatively
   * idle session would wait for a turn that may never start. Idle follow-up input
   * is therefore delivered as an ordinary prompt, matching what typing into an idle
   * Pi session does, while active follow-up keeps its queued semantics.
   */
  send(message: string, delivery: PiDeliveryMode = "steer"): Promise<void> {
    return this.#enqueue(async () => {
      const queueFollowUp = delivery === "followUp" && (await this.#isActive());
      this.#mayBeWorking = true;
      try {
        if (queueFollowUp) await this.process.followUp(message);
        else await this.process.prompt(message);
      } catch (error: unknown) {
        this.#mayBeWorking = false;
        throw error;
      }
    });
  }

  async #isActive(): Promise<boolean> {
    if (this.#mayBeWorking) return true;
    const state = await this.process.getState();
    return state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0;
  }

  reconcileState(): Promise<PiState> {
    return this.#enqueue(async () => {
      const state = await this.process.getState();
      this.#applyObservedState(state);
      await this.store.putAgent(this.agent);
      return state;
    });
  }

  compact(): Promise<PiCompactionResult> {
    return this.#enqueue(async () => {
      const state = await this.process.getState();
      if (
        this.#mayBeWorking ||
        this.agent.summary.state !== "idle" ||
        state.isStreaming ||
        state.isCompacting ||
        state.pendingMessageCount !== 0
      ) {
        throw new Error("Agent is busy");
      }
      this.#mayBeWorking = true;
      this.agent = {
        ...this.agent,
        summary: {
          ...this.agent.summary,
          state: "working",
          process: { state: "resident" },
          error: undefined,
        },
      };
      await this.store.putAgent(this.agent);
      try {
        const result = await this.process.compact();
        await this.#markIdle();
        return result;
      } catch (error: unknown) {
        this.#mayBeWorking = false;
        if (error instanceof PiCompactionError) await this.#markIdle();
        throw error;
      }
    });
  }

  async registerIdleWaiter(
    signal?: AbortSignal,
  ): Promise<{ readonly completion: Promise<IdleBoundary> }> {
    let wait: Promise<IdleBoundary> | null = null;
    await this.#enqueue(async () => {
      if (signal?.aborted === true) throw new Error("Receive cancelled");
      if (
        !this.#mayBeWorking &&
        this.agent.summary.state === "idle" &&
        this.#idleEventPosition !== null
      ) {
        wait = Promise.resolve({
          agent: this.agent,
          idleEventPosition: this.#idleEventPosition,
        });
        return;
      }

      let resolveIdle!: (boundary: IdleBoundary) => void;
      let rejectIdle!: (error: Error) => void;
      const pending = new Promise<IdleBoundary>((resolve, reject) => {
        resolveIdle = resolve;
        rejectIdle = reject;
      });
      void pending.catch(() => undefined);
      wait = pending;
      const waiter: IdleWaiter = {
        resolve: resolveIdle,
        reject: rejectIdle,
        ...(signal === undefined ? {} : { signal }),
      };
      this.#idleWaiters.add(waiter);
      if (signal !== undefined) {
        const onAbort = () => {
          this.#idleWaiters.delete(waiter);
          rejectIdle(new Error("Receive cancelled"));
        };
        (waiter as { onAbort?: () => void }).onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      if (!this.#idleWaiters.has(waiter)) return;

      const state = await this.process.getState();
      if (!state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0) {
        await this.#markIdle();
      }
    });
    if (wait === null) throw new Error("Idle waiter registration failed");
    return { completion: wait };
  }

  async waitForIdle(signal?: AbortSignal): Promise<IdleBoundary> {
    const registered = await this.registerIdleWaiter(signal);
    return registered.completion;
  }

  async stop(reason: CoordinatorStopReason): Promise<void> {
    this.#stopReason = reason;
    await this.store.putIncarnation({
      incarnationId: this.incarnationId,
      agentId: this.agent.summary.id,
      agentName: this.agent.summary.name,
      pid: this.process.pid,
      state: "stopping",
    });
    try {
      await this.process.stop();
      await this.#lane;
    } catch (error: unknown) {
      this.agent = {
        ...this.agent,
        summary: {
          ...this.agent.summary,
          state: "failed",
          process: { state: "cleanup_uncertain" },
          error: { code: "incarnation_cleanup_uncertain" },
        },
      };
      await this.store.putAgent(this.agent);
      await this.store.putIncarnation({
        incarnationId: this.incarnationId,
        agentId: this.agent.summary.id,
        agentName: this.agent.summary.name,
        pid: this.process.pid,
        state: "cleanup_uncertain",
      });
      throw error;
    }
  }

  async #handleProcessExit(error: Error | null): Promise<void> {
    this.#unsubscribeFrame();
    this.#unsubscribeExit();
    if (this.#stopReason === null) {
      await this.process.stop().catch(() => undefined);
    }
    const groupGone = await waitForProcessGroupExit(this.process.pid);
    if (!groupGone) {
      this.agent = {
        ...this.agent,
        summary: {
          ...this.agent.summary,
          state: "failed",
          process: { state: "cleanup_uncertain" },
          error: { code: "incarnation_cleanup_uncertain" },
        },
      };
      await this.store.putAgent(this.agent);
      await this.store.putIncarnation({
        incarnationId: this.incarnationId,
        agentId: this.agent.summary.id,
        agentName: this.agent.summary.name,
        pid: this.process.pid,
        state: "cleanup_uncertain",
      });
      this.#rejectIdleWaiters(new Error("Pi process cleanup is uncertain"));
      this.onProcessExit(error ?? new Error("Pi process group is still alive"));
      return;
    }

    const wasActive =
      this.agent.summary.state === "working" || this.agent.summary.state === "restoring";
    const destroyed = this.#stopReason === "destroy";
    const interrupted =
      this.agent.summary.state === "failed" ||
      (error !== null && this.#stopReason === null) ||
      (wasActive && this.#stopReason !== "destroy");
    const state = destroyed ? "destroying" : interrupted ? "failed" : "idle";
    this.agent = {
      ...this.agent,
      summary: {
        ...this.agent.summary,
        state,
        process: { state: "absent" },
        ...(interrupted ? { error: { code: "runtime_interrupted" } } : { error: undefined }),
      },
    };
    await this.store.putAgent(this.agent);
    await this.store.putIncarnation({
      incarnationId: this.incarnationId,
      agentId: this.agent.summary.id,
      agentName: this.agent.summary.name,
      pid: this.process.pid,
      state: "gone",
    });
    if (interrupted || destroyed) {
      this.#rejectIdleWaiters(new Error(destroyed ? "Agent destroyed" : "Pi work was interrupted"));
    } else {
      this.#resolveIdleWaiters();
    }
    this.onProcessExit(error);
  }

  async #markWorking(): Promise<void> {
    this.#mayBeWorking = true;
    this.#idleEventPosition = null;
    this.agent = {
      ...this.agent,
      summary: {
        ...this.agent.summary,
        state: "working",
        process: { state: "resident" },
        error: undefined,
      },
    };
    await this.store.putAgent(this.agent);
  }

  async #markIdle(): Promise<void> {
    const state = await this.process.getState();
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) return;
    this.#applyObservedState(state);
    const idleAgent: StoredAgent = {
      ...this.agent,
      summary: {
        ...this.agent.summary,
        state: "idle",
        process: { state: "resident" },
        error: undefined,
      },
    };
    try {
      const idleEventPosition = (await this.onIdle?.(idleAgent)) ?? null;
      await this.store.putAgent(idleAgent);
      this.agent = idleAgent;
      this.#idleEventPosition = idleEventPosition;
      this.#mayBeWorking = false;
      this.#resolveIdleWaiters();
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error("Idle durability failed");
      this.agent = {
        ...idleAgent,
        summary: {
          ...idleAgent.summary,
          state: "failed",
          error: { code: "storage_unavailable" },
        },
      };
      await this.store.putAgent(this.agent).catch(() => undefined);
      this.#rejectIdleWaiters(failure);
      throw failure;
    }
  }

  #applyObservedState(state: PiState): void {
    this.agent = {
      ...this.agent,
      launch: observeSession(this.agent.launch, {
        path: state.sessionFile ?? null,
        id: state.sessionId,
      }),
      summary: {
        ...this.agent.summary,
        session: { path: state.sessionFile ?? null, id: state.sessionId },
      },
    };
  }

  #resolveIdleWaiters(): void {
    for (const waiter of this.#idleWaiters) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({
        agent: this.agent,
        idleEventPosition: this.#idleEventPosition ?? 0,
      });
    }
    this.#idleWaiters.clear();
  }

  #rejectIdleWaiters(error: Error): void {
    for (const waiter of this.#idleWaiters) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
    this.#idleWaiters.clear();
  }

  #queueEvent(operation: () => Promise<void>): void {
    void this.#enqueue(operation).catch((error: unknown) => this.#handleEventFailure(error));
  }

  async #handleEventFailure(error: unknown): Promise<void> {
    if (this.#handlingFailure) return;
    this.#handlingFailure = true;
    const failure = error instanceof Error ? error : new Error("Agent coordinator failed");
    this.#rejectIdleWaiters(failure);
    await this.process.stop().catch(() => undefined);
    this.onProcessExit(failure);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lane.then(operation, operation);
    this.#lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
