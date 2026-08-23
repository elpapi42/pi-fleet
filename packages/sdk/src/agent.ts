import type { Agent, AgentStatus, SendOptions, SendResult } from "./types.js"

type AgentClient = {
  status(id: string, name: string): Promise<AgentStatus>
  send(id: string, name: string, message: string, options?: SendOptions): Promise<SendResult>
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
}
