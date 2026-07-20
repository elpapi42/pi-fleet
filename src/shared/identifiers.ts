export type AgentName = string & { readonly __brand: "AgentName" };

const AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isAgentName(value: string): value is AgentName {
  return AGENT_NAME_PATTERN.test(value);
}
