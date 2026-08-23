export const version = "0.5.0"

export { connectPiFleet } from "./fleet/client.js"
export {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentUnavailableError,
} from "./fleet/agent.js"

export type {
  Agent,
  AgentEvent,
  AgentState,
  AgentStatus,
  AgentSummary,
  SendDelivery,
  SendOptions,
  SendResult,
} from "./fleet/agent.js"
export type {
  ConnectOptions,
  CreateAgentOptions,
  PiFleetClient,
} from "./fleet/client.js"
