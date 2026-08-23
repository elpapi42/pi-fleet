export const version = "0.8.0"

export { connectPiFleet } from "./fleet/client.js"
export {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentUnavailableError,
  AgentRecoveryQueueFullError,
  AgentSendUncertainError,
  InvalidCursorError,
} from "./fleet/agent.js"

export type {
  Agent,
  AgentEvent,
  EventCursor,
  ReceiveOptions,
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
