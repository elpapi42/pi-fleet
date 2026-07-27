import type { ExpectedAgentTarget, ReceiveStart } from "./agent-target.js";
import type {
  AgentId,
  AgentSummary,
  PiFleetErrorCode,
  ReceiveCursor,
  ReceiveStream,
} from "./contracts.js";

export type SendDelivery = "steer" | "followUp";

export interface ConnectPiFleetOptions {
  readonly stateRoot?: string;
  readonly applicationRoot?: string;
  readonly autoStartRuntime?: boolean;
  readonly signal?: AbortSignal;
}

export interface CreateAgentInput {
  readonly name: string;
  readonly cwd: string;
  readonly piArgs?: readonly string[];
  readonly instructions?: string;
}

export interface SdkRequestOptions {
  readonly signal?: AbortSignal;
}

export interface InputReceipt {
  readonly acceptedAt: string;
}

export interface CompactionSummary {
  readonly tokensBefore: number;
  readonly estimatedTokensAfter?: number;
}

export type AgentReceiveOptions = { readonly signal?: AbortSignal } & (
  | { readonly after?: never; readonly fromStart?: false }
  | { readonly after: ReceiveCursor; readonly fromStart?: never }
  | { readonly after?: never; readonly fromStart: true }
);

export interface PiFleetClient {
  create(input: CreateAgentInput, options?: SdkRequestOptions): Promise<Agent>;
  get(name: string, options?: SdkRequestOptions): Promise<Agent>;
  list(options?: SdkRequestOptions): Promise<readonly AgentSummary[]>;
  close(): Promise<void>;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  status(options?: SdkRequestOptions): Promise<AgentSummary>;
  send(
    message: string,
    options?: { readonly delivery?: SendDelivery; readonly signal?: AbortSignal },
  ): Promise<InputReceipt>;
  receive(options?: AgentReceiveOptions): Promise<ReceiveStream>;
  compact(options?: SdkRequestOptions): Promise<CompactionSummary>;
  destroy(options?: SdkRequestOptions): Promise<void>;
}

export interface SdkTransport {
  create(input: CreateAgentInput, signal: AbortSignal): Promise<AgentSummary>;
  get(name: string, signal: AbortSignal): Promise<AgentSummary | null>;
  list(signal: AbortSignal): Promise<readonly AgentSummary[]>;
  status(target: ExpectedAgentTarget, signal: AbortSignal): Promise<AgentSummary>;
  send(
    target: ExpectedAgentTarget,
    message: string,
    delivery: SendDelivery,
    signal: AbortSignal,
  ): Promise<InputReceipt>;
  receive(
    target: ExpectedAgentTarget,
    start: ReceiveStart,
    signal: AbortSignal,
    untilIdle?: boolean,
  ): Promise<ReceiveStream>;
  compact(target: ExpectedAgentTarget, signal: AbortSignal): Promise<CompactionSummary>;
  destroy(target: ExpectedAgentTarget, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface SdkConnector {
  connect(options: ConnectPiFleetOptions): Promise<SdkTransport>;
}

export type ConnectPiFleet = (options?: ConnectPiFleetOptions) => Promise<PiFleetClient>;

/** Creates the public connector while keeping runtime discovery outside this inert module. */
export function createConnectPiFleet(connector: SdkConnector): ConnectPiFleet {
  return async (options = {}) => createPiFleetClient(await connector.connect(options));
}

/** @internal Shared CLI/SDK construction seam; not exported by the public client entry. */
export function createPiFleetClient(transport: SdkTransport): PiFleetClient {
  return new PiFleetClientImpl(transport);
}

class PiFleetClientImpl implements PiFleetClient {
  #closed = false;
  readonly #closedController = new AbortController();

  constructor(readonly transport: SdkTransport) {}

  async create(input: CreateAgentInput, options: SdkRequestOptions = {}): Promise<Agent> {
    return this.agent(
      await this.callAgent(() => this.transport.create(input, this.signal(options.signal))),
    );
  }

  async get(name: string, options: SdkRequestOptions = {}): Promise<Agent> {
    const summary = await this.callAgent(() =>
      this.transport.get(name, this.signal(options.signal)),
    );
    if (summary === null) {
      throw new PiFleetError("agent_not_found", `Agent ${name} was not found.`);
    }
    return this.agent(summary);
  }

  async list(options: SdkRequestOptions = {}): Promise<readonly AgentSummary[]> {
    return this.callAgent(() => this.transport.list(this.signal(options.signal)));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedController.abort();
    await this.transport.close();
  }

  agent(summary: AgentSummary): Agent {
    return new AgentImpl(this, this.transport, summary);
  }

  async callAgent<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try {
      return await operation();
    } catch (error: unknown) {
      throw PiFleetError.from(error);
    }
  }

  signal(signal?: AbortSignal): AbortSignal {
    this.assertOpen();
    return signal === undefined
      ? this.#closedController.signal
      : AbortSignal.any([signal, this.#closedController.signal]);
  }

  private assertOpen(): void {
    if (this.#closed) throw new PiFleetError("runtime_unavailable", "pi-fleet client is closed");
  }
}

interface AgentInternals {
  readonly client: PiFleetClientImpl;
  readonly transport: SdkTransport;
  readonly initialSummary: AgentSummary;
}

const agentInternals = new WeakMap<Agent, AgentInternals>();

class AgentImpl implements Agent {
  readonly id: AgentId;
  readonly name: string;

  constructor(
    private readonly client: PiFleetClientImpl,
    private readonly transport: SdkTransport,
    initialSummary: AgentSummary,
  ) {
    this.id = initialSummary.id as AgentId;
    this.name = initialSummary.name;
    agentInternals.set(this, { client, transport, initialSummary });
  }

  status(options: SdkRequestOptions = {}): Promise<AgentSummary> {
    return this.client.callAgent(() =>
      this.transport.status(this.target(), this.client.signal(options.signal)),
    );
  }

  send(
    message: string,
    options: { readonly delivery?: SendDelivery; readonly signal?: AbortSignal } = {},
  ): Promise<InputReceipt> {
    return this.client.callAgent(() =>
      this.transport.send(
        this.target(),
        message,
        options.delivery ?? "steer",
        this.client.signal(options.signal),
      ),
    );
  }

  receive(options: AgentReceiveOptions = {}): Promise<ReceiveStream> {
    return this.receiveInternal(options, false);
  }

  receiveInternal(options: AgentReceiveOptions, untilIdle: boolean): Promise<ReceiveStream> {
    return this.client.callAgent(() =>
      this.transport.receive(
        this.target(),
        receiveStart(options),
        this.client.signal(options.signal),
        untilIdle,
      ),
    );
  }

  compact(options: SdkRequestOptions = {}): Promise<CompactionSummary> {
    return this.client.callAgent(() =>
      this.transport.compact(this.target(), this.client.signal(options.signal)),
    );
  }

  destroy(options: SdkRequestOptions = {}): Promise<void> {
    return this.client.callAgent(() =>
      this.transport.destroy(this.target(), this.client.signal(options.signal)),
    );
  }

  private target(): ExpectedAgentTarget {
    return { name: this.name, expectedAgentId: this.id };
  }
}

function receiveStart(options: AgentReceiveOptions): ReceiveStart {
  if ("after" in options && options.after !== undefined) {
    return { kind: "after", cursor: options.after };
  }
  if ("fromStart" in options && options.fromStart === true) return { kind: "start" };
  return { kind: "live" };
}

/** @internal CLI adapter; not exported from the public client entry. */
export function agentInitialStatus(agent: Agent): AgentSummary {
  return requireAgentInternals(agent).initialSummary;
}

/** @internal CLI-only finite projection over the same continuous receive contract. */
export function receiveAgentUntilIdle(
  agent: Agent,
  options: SdkRequestOptions = {},
): Promise<ReceiveStream> {
  const { client, transport } = requireAgentInternals(agent);
  return client.callAgent(() =>
    transport.receive(
      { name: agent.name, expectedAgentId: agent.id },
      { kind: "live" },
      client.signal(options.signal),
      true,
    ),
  );
}

function requireAgentInternals(agent: Agent): AgentInternals {
  const internals = agentInternals.get(agent);
  if (internals === undefined) throw new Error("Unknown pi-fleet Agent handle");
  return internals;
}

export class PiFleetError extends Error {
  constructor(
    readonly code: PiFleetErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "PiFleetError";
  }

  static from(error: unknown): PiFleetError {
    if (error instanceof PiFleetError) return error;
    return new PiFleetError("internal_error", "pi-fleet client operation failed");
  }
}
