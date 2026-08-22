export type AgentState = "starting" | "idle" | "working" | "stopped" | "failed"

export type ConnectOptions = {
  /** A private state directory. Intended for isolated tests and advanced local setups. */
  stateDir?: string
}

export type CreateAgentOptions = {
  name: string
  cwd: string
  instructions?: string
  piArgs?: string[]
}

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

export interface Agent {
  readonly id: string
  readonly name: string
  status(): Promise<AgentStatus>
}

export interface PiFleetClient {
  create(options: CreateAgentOptions): Promise<Agent>
  get(name: string): Promise<Agent>
  list(): Promise<AgentSummary[]>
  close(): Promise<void>
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
