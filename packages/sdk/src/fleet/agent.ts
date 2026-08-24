export type AgentState = "starting" | "idle" | "working" | "failed"

export type AgentSummary = {
  id: string
  name: string
  cwd: string
  state: AgentState
}

export type AgentStatus = {
  id: string
  name: string
  state: AgentState
}

export type SendDelivery = "steer" | "followUp"

export type SendOptions = {
  delivery?: SendDelivery
}

export type SendResult = {
  acceptedAt: number
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type ToolOutput = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; byteLength: number; omitted: true }
  >
  details?: JsonValue
  detailsTruncated: boolean
  truncated: boolean
}

export type EventCursor = string

export type ReceiveOptions =
  | { fromStart: true; after?: never }
  | { after: EventCursor; fromStart?: never }
  | { fromStart?: false; after?: never }

export type UnsequencedAgentEvent = DistributiveOmit<AgentEvent, "cursor">

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never

type AgentEventBase = {
  cursor: EventCursor
  eventId: string
  activityId: string
  timestamp: number
}

export type AgentEvent =
  | (AgentEventBase & { type: "thinking.started" })
  | (AgentEventBase & { type: "thinking.finished"; content: string })
  | (AgentEventBase & { type: "message.started" })
  | (AgentEventBase & { type: "message.finished"; text: string })
  | (AgentEventBase & { type: "tool.started"; toolName: string; args: JsonValue; argsTruncated: boolean })
  | (AgentEventBase & { type: "tool.finished"; toolName: string; isError: boolean; output: ToolOutput })
  | (AgentEventBase & { type: "work.interrupted" })
  | (AgentEventBase & { type: "agent.destroyed" })

export interface Agent {
  readonly id: string
  readonly name: string
  status(): Promise<AgentStatus>
  send(message: string, options?: SendOptions): Promise<SendResult>
  receive(options?: ReceiveOptions): AsyncIterable<AgentEvent>
  destroy(): Promise<void>
}

export class AgentNameTakenError extends Error {
  constructor(name: string) {
    super(`An agent named ${JSON.stringify(name)} already exists`)
    this.name = "AgentNameTakenError"
  }
}

export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`No agent named ${JSON.stringify(name)} exists`)
    this.name = "AgentNotFoundError"
  }
}

export class AgentUnavailableError extends Error {
  constructor(name: string) {
    super(`Agent ${JSON.stringify(name)} is unavailable`)
    this.name = "AgentUnavailableError"
  }
}

export class AgentRecoveryQueueFullError extends Error {
  constructor(name: string) {
    super(`Agent ${JSON.stringify(name)} recovery queue is full`)
    this.name = "AgentRecoveryQueueFullError"
  }
}

export class AgentSendUncertainError extends Error {
  constructor(name: string) {
    super(`Instruction sent to agent ${JSON.stringify(name)} may have been accepted by Pi`)
    this.name = "AgentSendUncertainError"
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid event cursor")
    this.name = "InvalidCursorError"
  }
}

type AgentClient = {
  status(id: string, name: string): Promise<AgentStatus>
  send(id: string, name: string, message: string, options?: SendOptions): Promise<SendResult>
  receive(id: string, name: string, options?: ReceiveOptions): AsyncIterable<AgentEvent>
  destroy(id: string, name: string): Promise<void>
}

export class AgentHandle implements Agent {
  readonly #client: AgentClient
  readonly #id: string
  readonly #name: string

  constructor(client: AgentClient, id: string, name: string) {
    this.#client = client
    this.#id = id
    this.#name = name
  }

  get id(): string {
    return this.#id
  }

  get name(): string {
    return this.#name
  }

  status(): Promise<AgentStatus> {
    return this.#client.status(this.#id, this.#name)
  }

  send(message: string, options?: SendOptions): Promise<SendResult> {
    return this.#client.send(this.#id, this.#name, message, options)
  }

  receive(options?: ReceiveOptions): AsyncIterable<AgentEvent> {
    return this.#client.receive(this.#id, this.#name, options)
  }

  destroy(): Promise<void> {
    return this.#client.destroy(this.#id, this.#name)
  }
}
