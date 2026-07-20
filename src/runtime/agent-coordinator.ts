import type { PiProcess } from "../pi/process.js";
import { waitForProcessGroupExit } from "../platform/runtime/process-tree.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";

export type CoordinatorStopReason = "destroy" | "runtime_shutdown" | "idle_release";

interface IdleWaiter {
  readonly resolve: () => void;
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
  #unsubscribeFrame: () => void;
  #unsubscribeExit: () => void;

  constructor(
    private readonly store: FleetStore,
    private agent: StoredAgent,
    readonly process: PiProcess,
    readonly incarnationId: string,
    private readonly now: () => string,
    private readonly onProcessExit: (error: Error | null) => void,
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

  send(message: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#mayBeWorking = true;
      try {
        await this.process.prompt(message);
      } catch (error: unknown) {
        this.#mayBeWorking = false;
        throw error;
      }
    });
  }

  async waitForIdle(signal?: AbortSignal): Promise<StoredAgent> {
    let wait: Promise<void> | null = null;
    await this.#enqueue(async () => {
      if (!this.#mayBeWorking && this.agent.summary.state === "idle") return;
      if (signal?.aborted === true) throw new Error("Receive cancelled");

      let resolveIdle!: () => void;
      let rejectIdle!: (error: Error) => void;
      const pending = new Promise<void>((resolve, reject) => {
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
      if (!state.isStreaming && state.pendingMessageCount === 0) {
        await this.#markIdle();
      }
    });
    if (wait !== null) await wait;
    await this.#lane;
    return this.agent;
  }

  async stop(reason: CoordinatorStopReason): Promise<void> {
    this.#stopReason = reason;
    await this.store.putIncarnation({
      incarnationId: this.incarnationId,
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
    const latestAssistantText = await this.process.getLastAssistantText();
    this.#mayBeWorking = false;
    this.agent = {
      ...this.agent,
      latestAssistantText,
      responseObservedAt: latestAssistantText === null ? this.agent.responseObservedAt : this.now(),
      summary: {
        ...this.agent.summary,
        state: "idle",
        process: { state: "resident" },
        error: undefined,
      },
    };
    await this.store.putAgent(this.agent);
    this.#resolveIdleWaiters();
  }

  #resolveIdleWaiters(): void {
    for (const waiter of this.#idleWaiters) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve();
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
