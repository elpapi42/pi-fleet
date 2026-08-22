export const version = "0.2.0"

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
} from "./types.js"
