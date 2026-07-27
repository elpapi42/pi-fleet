import type {
  FleetClient,
  FleetClientError,
  OperationIdentity,
  ReceiveInput,
  ReceiveStreamItem,
} from "./fleet-client.js";
import type { ExpectedAgentTarget, ReceiveStart } from "./agent-target.js";
import {
  PiFleetError,
  type CompactionSummary,
  type CreateAgentInput,
  type InputReceipt,
  type SdkTransport,
  type SendDelivery,
} from "./sdk-facade.js";
import {
  isPiFleetErrorCode,
  type AgentSummary,
  type ReceiveCursor,
  type ReceiveStream,
  type SemanticEvent,
} from "./contracts.js";
import type { Result } from "../shared/result.js";

export interface FleetClientSdkTransportOptions {
  readonly reconnectDelayMs?: number;
  readonly autoReconnect?: boolean;
}

/** Public-shape adapter over the private Result/wire-oriented client. */
export class FleetClientSdkTransport implements SdkTransport {
  readonly #reconnectDelayMs: number;
  readonly #autoReconnect: boolean;
  readonly #activeReceiveIterators = new Set<
    AsyncIterator<Result<ReceiveStreamItem, FleetClientError>>
  >();
  #closed = false;

  constructor(
    private readonly client: FleetClient,
    private readonly operationIds: () => OperationIdentity,
    options: FleetClientSdkTransportOptions = {},
  ) {
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 50;
    this.#autoReconnect = options.autoReconnect !== false;
  }

  async create(input: CreateAgentInput, signal: AbortSignal): Promise<AgentSummary> {
    const result = await this.client.create(
      {
        name: input.name,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        cwd: input.cwd,
        piArgv: input.piArgs ?? [],
      },
      { signal, operation: this.operationIds() },
    );
    return unwrap(result).agent;
  }

  async get(name: string, signal: AbortSignal): Promise<AgentSummary | null> {
    const result = await this.client.status({ name }, { signal });
    if (!result.ok && result.error.code === "agent_not_found") return null;
    return unwrap(result).agent;
  }

  async list(signal: AbortSignal): Promise<readonly AgentSummary[]> {
    return unwrap(await this.client.list({ signal })).agents;
  }

  async status(target: ExpectedAgentTarget, signal: AbortSignal): Promise<AgentSummary> {
    return unwrap(await this.client.status(target, { signal })).agent;
  }

  async send(
    target: ExpectedAgentTarget,
    message: string,
    delivery: SendDelivery,
    signal: AbortSignal,
  ): Promise<InputReceipt> {
    const result = unwrap(
      await this.client.send(
        { ...target, message, delivery },
        { signal, operation: this.operationIds() },
      ),
    );
    return { acceptedAt: result.acceptedAt };
  }

  async receive(
    target: ExpectedAgentTarget,
    start: ReceiveStart,
    signal: AbortSignal,
    untilIdle = false,
  ): Promise<ReceiveStream> {
    const initial = await this.#attach(target, start, signal, undefined, untilIdle);
    let iterated = false;
    return {
      cursor: initial.cursor,
      [Symbol.asyncIterator]: () => {
        if (iterated) {
          throw new PiFleetError("invalid_request", "A receive stream can be iterated only once.");
        }
        iterated = true;
        return this.#events(target, initial, signal, untilIdle);
      },
    };
  }

  async compact(target: ExpectedAgentTarget, signal: AbortSignal): Promise<CompactionSummary> {
    return unwrap(await this.client.compact(target, { signal, operation: this.operationIds() }))
      .compaction;
  }

  async destroy(target: ExpectedAgentTarget, signal: AbortSignal): Promise<void> {
    unwrap(await this.client.destroy(target, { signal, operation: this.operationIds() }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const iterators = [...this.#activeReceiveIterators];
    this.#activeReceiveIterators.clear();
    await Promise.allSettled(iterators.map(async (iterator) => iterator.return?.()));
  }

  async *#events(
    target: ExpectedAgentTarget,
    initial: ReceiveAttachment,
    signal: AbortSignal,
    untilIdle: boolean,
  ): AsyncGenerator<SemanticEvent> {
    let attachment = initial;
    let cursor = initial.cursor;
    while (true) {
      let reconnect = false;
      try {
        while (true) {
          const next = await attachment.iterator.next();
          if (next.done) {
            throwIfAborted(signal);
            return;
          }
          const result = next.value;
          if (!result.ok) {
            if (result.error.code === "runtime_unavailable" && !untilIdle && this.#autoReconnect) {
              reconnect = true;
              break;
            }
            throw publicError(result.error);
          }
          if (result.value.type === "ready") {
            throw new PiFleetError("protocol_error", "Receive emitted duplicate readiness.");
          }
          cursor = result.value.cursor;
          yield result.value.event;
        }
      } finally {
        await this.#release(attachment.iterator);
      }
      if (!reconnect) return;
      await abortableDelay(this.#reconnectDelayMs, signal);
      attachment = await this.#attach(target, { kind: "after", cursor }, signal, cursor, false);
    }
  }

  async #attach(
    target: ExpectedAgentTarget,
    start: ReceiveStart,
    signal: AbortSignal,
    expectedCursor?: ReceiveCursor,
    untilIdle = false,
  ): Promise<ReceiveAttachment> {
    while (true) {
      throwIfAborted(signal);
      if (this.#closed) {
        throw new PiFleetError("runtime_unavailable", "pi-fleet client is closed");
      }
      const input: ReceiveInput = {
        ...target,
        start,
        ...(untilIdle ? { untilIdle: true } : {}),
      };
      const iterator = this.client.receive(input, { signal })[Symbol.asyncIterator]();
      this.#activeReceiveIterators.add(iterator);
      let first: IteratorResult<Result<ReceiveStreamItem, FleetClientError>>;
      try {
        first = await iterator.next();
      } catch (error: unknown) {
        await this.#release(iterator);
        throw error;
      }
      if (first.done) {
        await this.#release(iterator);
        throwIfAborted(signal);
        throw new PiFleetError(
          "runtime_unavailable",
          "Runtime connection closed before receive readiness.",
        );
      }
      if (!first.value.ok) {
        await this.#release(iterator);
        if (first.value.error.code === "runtime_unavailable" && this.#autoReconnect) {
          await abortableDelay(this.#reconnectDelayMs, signal);
          continue;
        }
        throw publicError(first.value.error);
      }
      if (first.value.value.type !== "ready") {
        await this.#release(iterator);
        throw new PiFleetError("protocol_error", "Receive event arrived before readiness.");
      }
      if (expectedCursor !== undefined && first.value.value.cursor !== expectedCursor) {
        await this.#release(iterator);
        throw new PiFleetError(
          "protocol_error",
          "Reconnected receive boundary does not match the last emitted cursor.",
        );
      }
      return { cursor: first.value.value.cursor, iterator };
    }
  }

  async #release(
    iterator: AsyncIterator<Result<ReceiveStreamItem, FleetClientError>>,
  ): Promise<void> {
    this.#activeReceiveIterators.delete(iterator);
    await iterator.return?.();
  }
}

interface ReceiveAttachment {
  readonly cursor: ReceiveCursor;
  readonly iterator: AsyncIterator<Result<ReceiveStreamItem, FleetClientError>>;
}

function unwrap<T>(result: Result<T, FleetClientError>): T {
  if (result.ok) return result.value;
  throw publicError(result.error);
}

function publicError(error: FleetClientError): PiFleetError {
  if (!isPiFleetErrorCode(error.code)) {
    return new PiFleetError("internal_error", "pi-fleet client operation failed");
  }
  return new PiFleetError(error.code, error.message, error.details);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PiFleetError("cancelled", "Operation cancelled.");
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (durationMs === 0) return Promise.resolve();
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(new PiFleetError("cancelled", "Operation cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
