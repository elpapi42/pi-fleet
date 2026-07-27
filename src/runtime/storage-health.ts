import type { ReceiveCursor } from "./semantic-events.js";

export type StorageHealthState =
  | { readonly state: "healthy" }
  | {
      readonly state: "failed";
      readonly error: Error;
      readonly lastDurableCursor: ReceiveCursor | null;
    };

export class StorageCommitDelayError extends Error {
  readonly code = "storage_unavailable";

  constructor(message = "A Pi response is waiting for durable journal storage.") {
    super(message);
    this.name = "StorageCommitDelayError";
  }
}

export class StorageHealthController {
  #health: StorageHealthState = { state: "healthy" };
  readonly #listeners = new Set<(health: StorageHealthState) => void>();

  get health(): StorageHealthState {
    return this.#health;
  }

  onChange(listener: (health: StorageHealthState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  fail(error: Error, lastDurableCursor: ReceiveCursor | null): void {
    if (this.#health.state === "failed") return;
    this.#health = { state: "failed", error, lastDurableCursor };
    for (const listener of this.#listeners) listener(this.#health);
  }

  assertHealthy(): void {
    if (this.#health.state === "failed") throw this.#health.error;
  }
}

export interface CleanDrainSteps {
  readonly stopAdmission: () => Promise<void> | void;
  readonly drainStdoutAndJournal: () => Promise<void>;
  readonly closeReceivers: () => Promise<void>;
  readonly stopProcessTrees: () => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly closeStore: () => Promise<void>;
}

/** Idempotent shutdown ordering shared by the future coordinated runtime cutover. */
export class CleanDrainCoordinator {
  #closing: Promise<void> | null = null;

  constructor(private readonly steps: CleanDrainSteps) {}

  close(): Promise<void> {
    this.#closing ??= this.#run();
    return this.#closing;
  }

  async #run(): Promise<void> {
    const steps = [
      () => this.steps.stopAdmission(),
      () => this.steps.drainStdoutAndJournal(),
      () => this.steps.closeReceivers(),
      () => this.steps.stopProcessTrees(),
      () => this.steps.closeServer(),
      () => this.steps.closeStore(),
    ];
    let firstError: unknown;
    for (const step of steps) {
      try {
        await step();
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
