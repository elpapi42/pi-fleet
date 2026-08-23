export type AgentState = "starting" | "idle" | "working" | "stopped" | "failed"

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

export type AgentEvent =
  | { type: "thinking.started"; eventId: string; activityId: string; timestamp: number }
  | { type: "thinking.finished"; eventId: string; activityId: string; timestamp: number; content: string }
  | { type: "message.started"; eventId: string; activityId: string; timestamp: number }
  | { type: "message.finished"; eventId: string; activityId: string; timestamp: number; text: string }
  | { type: "tool.started"; eventId: string; activityId: string; timestamp: number; toolName: string; args: unknown }
  | { type: "tool.finished"; eventId: string; activityId: string; timestamp: number; toolName: string; isError: boolean }

export interface Agent {
  readonly id: string
  readonly name: string
  status(): Promise<AgentStatus>
  send(message: string, options?: SendOptions): Promise<SendResult>
  receive(): AsyncIterable<AgentEvent>
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

type AgentClient = {
  status(id: string, name: string): Promise<AgentStatus>
  send(id: string, name: string, message: string, options?: SendOptions): Promise<SendResult>
  receive(id: string, name: string): AsyncIterable<AgentEvent>
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

  receive(): AsyncIterable<AgentEvent> {
    return this.#client.receive(this.#id, this.#name)
  }
}
