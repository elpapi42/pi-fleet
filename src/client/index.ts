import { createSdkConnector } from "./sdk-connector.js";
import { createConnectPiFleet } from "./sdk-facade.js";

/** Explicit connection boundary for the shared per-user pi-fleet control plane. */
export const connectPiFleet = createConnectPiFleet(createSdkConnector());

export {
  PiFleetError,
  type Agent,
  type AgentReceiveOptions,
  type CompactionSummary,
  type ConnectPiFleetOptions,
  type CreateAgentInput,
  type InputReceipt,
  type PiFleetClient,
  type SdkRequestOptions,
  type SendDelivery,
} from "./sdk-facade.js";
export type {
  ActivityId,
  AgentEventId,
  AgentId,
  AgentState,
  AgentSummary,
  AssistantMessageFinishedEvent,
  AssistantMessageStartedEvent,
  AssistantThinkingFinishedEvent,
  AssistantThinkingStartedEvent,
  PiFleetErrorCode,
  ProcessState,
  ReceiveCursor,
  ReceiveStream,
  SemanticEvent,
  ToolExecutionFinishedEvent,
  ToolExecutionStartedEvent,
} from "./contracts.js";
