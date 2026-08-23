export const version = "0.6.1"

export { connectPiFleet } from "./fleet/client.js"
export {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentUnavailableError,
} from "./fleet/agent.js"

export type {
  Agent,
  AgentEvent,
  JsonValue,
  ToolOutput,
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
