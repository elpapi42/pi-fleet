export type RpcWatchErrorCode =
  | "watcher_lagged"
  | "watcher_capacity_exceeded"
  | "pi_start_failed"
  | "runtime_interrupted"
  | "runtime_unavailable";

export class RpcWatchError extends Error {
  constructor(
    readonly code: RpcWatchErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "RpcWatchError";
  }
}

interface WatchSubscription {
  readonly agentName: string;
  readonly signal: AbortSignal;
  readonly queue: Buffer[];
  readonly maxQueuedBytes: number;
  queuedBytes: number;
  incarnationId: string | null;
  ended: boolean;
  terminalError: RpcWatchError | null;
  wake: (() => void) | null;
  onAbort: () => void;
}

export class RpcWatchHub {
  readonly #subscriptions = new Map<string, Set<WatchSubscription>>();
  readonly #activeIncarnations = new Map<string, string>();

  constructor(
    private readonly limits: { readonly maxWatchers: number; readonly maxQueuedBytes: number },
  ) {}

  subscribe(agentName: string, signal: AbortSignal): AsyncIterable<Buffer> {
    if (this.#count() >= this.limits.maxWatchers) {
      throw new RpcWatchError("watcher_capacity_exceeded");
    }

    const subscription: WatchSubscription = {
      agentName,
      signal,
      queue: [],
      maxQueuedBytes: this.limits.maxQueuedBytes,
      queuedBytes: 0,
      incarnationId: this.#activeIncarnations.get(agentName) ?? null,
      ended: false,
      terminalError: null,
      wake: null,
      onAbort: () => this.#abort(subscription),
    };
    signal.addEventListener("abort", subscription.onAbort, { once: true });
    if (signal.aborted) subscription.onAbort();
    else {
      const subscriptions = this.#subscriptions.get(agentName) ?? new Set<WatchSubscription>();
      subscriptions.add(subscription);
      this.#subscriptions.set(agentName, subscriptions);
    }

    return { [Symbol.asyncIterator]: () => this.#iterator(subscription) };
  }

  beginIncarnation(agentName: string, incarnationId: string): (bytes: Buffer) => void {
    this.#activeIncarnations.set(agentName, incarnationId);
    for (const subscription of this.#subscriptions.get(agentName) ?? []) {
      if (subscription.incarnationId === null && !subscription.ended) {
        subscription.incarnationId = incarnationId;
      }
    }
    return (bytes) => this.#publish(agentName, incarnationId, bytes);
  }

  endIncarnation(
    agentName: string,
    incarnationId: string,
    error: RpcWatchError | null = null,
  ): void {
    if (this.#activeIncarnations.get(agentName) === incarnationId) {
      this.#activeIncarnations.delete(agentName);
    }
    for (const subscription of [...(this.#subscriptions.get(agentName) ?? [])]) {
      if (subscription.incarnationId === incarnationId) this.#endAfterDrain(subscription, error);
    }
  }

  closeAgent(agentName: string, error: RpcWatchError | null = null): void {
    this.#activeIncarnations.delete(agentName);
    for (const subscription of [...(this.#subscriptions.get(agentName) ?? [])]) {
      this.#endAfterDrain(subscription, error);
    }
  }

  closeAll(error: RpcWatchError | null = null): void {
    for (const agentName of [...this.#subscriptions.keys()]) this.closeAgent(agentName, error);
  }

  #publish(agentName: string, incarnationId: string, bytes: Buffer): void {
    for (const subscription of [...(this.#subscriptions.get(agentName) ?? [])]) {
      if (subscription.incarnationId !== incarnationId || subscription.ended) continue;
      if (subscription.queuedBytes + bytes.byteLength > subscription.maxQueuedBytes) {
        this.#finish(subscription, new RpcWatchError("watcher_lagged"));
        continue;
      }
      subscription.queue.push(Buffer.from(bytes));
      subscription.queuedBytes += bytes.byteLength;
      subscription.wake?.();
      subscription.wake = null;
    }
  }

  async *#iterator(subscription: WatchSubscription): AsyncGenerator<Buffer> {
    try {
      while (true) {
        while (subscription.queue.length > 0) {
          const bytes = subscription.queue.shift()!;
          subscription.queuedBytes -= bytes.byteLength;
          yield bytes;
        }
        if (subscription.terminalError !== null) throw subscription.terminalError;
        if (subscription.ended) return;
        await new Promise<void>((resolve) => {
          subscription.wake = resolve;
        });
      }
    } finally {
      this.#abort(subscription);
    }
  }

  #endAfterDrain(subscription: WatchSubscription, error: RpcWatchError | null = null): void {
    if (subscription.ended) return;
    subscription.ended = true;
    subscription.terminalError = error;
    subscription.wake?.();
    subscription.wake = null;
  }

  #finish(subscription: WatchSubscription, error: RpcWatchError | null = null): void {
    if (subscription.ended) return;
    subscription.ended = true;
    subscription.terminalError = error;
    subscription.wake?.();
    subscription.wake = null;
  }

  #abort(subscription: WatchSubscription): void {
    subscription.queue.length = 0;
    subscription.queuedBytes = 0;
    subscription.ended = true;
    subscription.terminalError = null;
    this.#remove(subscription);
    subscription.wake?.();
    subscription.wake = null;
  }

  #remove(subscription: WatchSubscription): void {
    subscription.signal.removeEventListener("abort", subscription.onAbort);
    const subscriptions = this.#subscriptions.get(subscription.agentName);
    if (subscriptions === undefined) return;
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) this.#subscriptions.delete(subscription.agentName);
  }

  #count(): number {
    let count = 0;
    for (const subscriptions of this.#subscriptions.values()) count += subscriptions.size;
    return count;
  }
}
