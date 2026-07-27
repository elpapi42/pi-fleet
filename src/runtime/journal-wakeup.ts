import type { AgentId } from "./semantic-events.js";
import type { ReceiveWakeup } from "./receive-pager.js";

interface Waiter {
  readonly afterPosition: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** In-memory wakeups are hints only; receive always re-reads SQLite. */
export class JournalWakeup implements ReceiveWakeup {
  readonly #positions = new Map<AgentId, number>();
  readonly #waiters = new Map<AgentId, Set<Waiter>>();
  readonly #failures = new Map<AgentId, Error>();
  #closedError: Error | null = null;

  notify(agentId: AgentId, position: number): void {
    if (this.#closedError !== null) return;
    this.#positions.set(agentId, Math.max(this.#positions.get(agentId) ?? 0, position));
    const waiters = this.#waiters.get(agentId);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) {
      if (position <= waiter.afterPosition) continue;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiters.delete(waiter);
      waiter.resolve();
    }
    if (waiters.size === 0) this.#waiters.delete(agentId);
  }

  waitForEvents(agentId: AgentId, afterPosition: number, signal: AbortSignal): Promise<void> {
    if (this.#closedError !== null) return Promise.reject(this.#closedError);
    const failure = this.#failures.get(agentId);
    if (failure !== undefined) return Promise.reject(failure);
    if ((this.#positions.get(agentId) ?? 0) > afterPosition) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new Error("Receive cancelled"));
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(agentId) ?? new Set<Waiter>();
      const waiter: Waiter = {
        afterPosition,
        resolve,
        reject,
        signal,
        onAbort: () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.#waiters.delete(agentId);
          reject(new Error("Receive cancelled"));
        },
      };
      waiters.add(waiter);
      this.#waiters.set(agentId, waiters);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const racedFailure = this.#failures.get(agentId);
      if (racedFailure !== undefined) {
        signal.removeEventListener("abort", waiter.onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(agentId);
        reject(racedFailure);
      } else if ((this.#positions.get(agentId) ?? 0) > afterPosition) {
        signal.removeEventListener("abort", waiter.onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(agentId);
        resolve();
      }
    });
  }

  failAgent(agentId: AgentId, error: Error): void {
    this.#failures.set(agentId, error);
    const waiters = this.#waiters.get(agentId);
    if (waiters === undefined) return;
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.#waiters.delete(agentId);
  }

  close(error = new Error("Runtime unavailable")): void {
    if (this.#closedError !== null) return;
    this.#closedError = error;
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }
}
