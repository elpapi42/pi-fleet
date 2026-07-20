import type { PiProcess } from "../pi/process.js";
import type { FleetStore, StoredAgent } from "../store/fleet-store.js";

export class AgentCoordinator {
  readonly #idleWaiters = new Set<{
    readonly resolve: () => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }>();
  #lane: Promise<void> = Promise.resolve();
  #stopping = false;
  #unsubscribeFrame: () => void;
  #unsubscribeExit: () => void;

  constructor(
    private readonly store: FleetStore,
    private agent: StoredAgent,
    readonly process: PiProcess,
    private readonly now: () => string,
    private readonly onProcessExit: (error: Error | null) => void,
  ) {
    this.#unsubscribeFrame = process.onFrame((frame) => {
      if (frame.type === "agent_start") this.#enqueue(() => this.#markWorking());
      if (frame.type === "agent_settled") this.#enqueue(() => this.#markIdle());
    });
    this.#unsubscribeExit = process.onExit((error) => {
      this.#enqueue(async () => {
        this.#unsubscribeFrame();
        this.#unsubscribeExit();
        const state = this.#stopping || error === null ? "idle" : "failed";
        this.agent = {
          ...this.agent,
          summary: {
            ...this.agent.summary,
            state,
            process: { state: "absent" },
          },
        };
        await this.store.putAgent(this.agent);
        this.#resolveIdleWaiters();
        this.onProcessExit(error);
      });
    });
  }

  get storedAgent(): StoredAgent {
    return this.agent;
  }

  async send(message: string): Promise<void> {
    await this.process.prompt(message);
  }

  async waitForIdle(signal?: AbortSignal): Promise<StoredAgent> {
    const state = await this.process.getState();
    if (!state.isStreaming && state.pendingMessageCount === 0) {
      await this.#enqueue(() => this.#markIdle());
      return this.agent;
    }
    await new Promise<void>((resolveIdle, rejectIdle) => {
      if (signal?.aborted === true) {
        rejectIdle(new Error("Receive cancelled"));
        return;
      }
      const waiter: {
        resolve: () => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve: resolveIdle, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          this.#idleWaiters.delete(waiter);
          rejectIdle(new Error("Receive cancelled"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#idleWaiters.add(waiter);
    });
    await this.#lane;
    return this.agent;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.process.stop();
    await this.#lane;
  }

  async #markWorking(): Promise<void> {
    this.agent = {
      ...this.agent,
      summary: { ...this.agent.summary, state: "working", process: { state: "resident" } },
    };
    await this.store.putAgent(this.agent);
  }

  async #markIdle(): Promise<void> {
    const latestAssistantText = await this.process.getLastAssistantText();
    this.agent = {
      ...this.agent,
      latestAssistantText,
      responseObservedAt: latestAssistantText === null ? this.agent.responseObservedAt : this.now(),
      summary: { ...this.agent.summary, state: "idle", process: { state: "resident" } },
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

  #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#lane = this.#lane.then(operation, operation);
    return this.#lane;
  }
}
