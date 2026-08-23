export const version = "0.4.0"

export { connectPiFleet } from "./client.js"
export {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentUnavailableError,
} from "./types.js"

export type {
  Agent,
  AgentState,
  AgentStatus,
  AgentSummary,
  ConnectOptions,
  CreateAgentOptions,
  PiFleetClient,
  SendDelivery,
  SendOptions,
  SendResult,
} from "./types.js"
