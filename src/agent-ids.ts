import { randomUUID } from "node:crypto";

declare const agentSessionIdBrand: unique symbol;
declare const agentConversationIdBrand: unique symbol;

/** Stable identity of an agent-level container. */
export type AgentSessionId = string & { readonly [agentSessionIdBrand]: true };

/** Stable identity of one conversation owned by an agent session. */
export type AgentConversationId = string & { readonly [agentConversationIdBrand]: true };

export const AGENT_SESSION_ID_PREFIX = "ags-";
export const AGENT_CONVERSATION_ID_PREFIX = "agc-";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const AGENT_SESSION_ID_PATTERN = new RegExp(`^${AGENT_SESSION_ID_PREFIX}${UUID_PATTERN}$`, "i");
const AGENT_CONVERSATION_ID_PATTERN = new RegExp(`^${AGENT_CONVERSATION_ID_PREFIX}${UUID_PATTERN}$`, "i");

/** Mint a collision-resistant, namespaced agent identity. */
export function createAgentSessionId(): AgentSessionId {
  return `${AGENT_SESSION_ID_PREFIX}${randomUUID()}` as AgentSessionId;
}

/** Mint a collision-resistant, namespaced conversation identity. */
export function createAgentConversationId(): AgentConversationId {
  return `${AGENT_CONVERSATION_ID_PREFIX}${randomUUID()}` as AgentConversationId;
}

export function isAgentSessionId(value: unknown): value is AgentSessionId {
  return typeof value === "string" && AGENT_SESSION_ID_PATTERN.test(value);
}

export function isAgentConversationId(value: unknown): value is AgentConversationId {
  return typeof value === "string" && AGENT_CONVERSATION_ID_PATTERN.test(value);
}

export function parseAgentSessionId(value: string): AgentSessionId {
  if (!isAgentSessionId(value)) {
    throw new TypeError(`invalid agent session id: expected ${AGENT_SESSION_ID_PREFIX}<uuid>`);
  }
  return value as AgentSessionId;
}

export function parseAgentConversationId(value: string): AgentConversationId {
  if (!isAgentConversationId(value)) {
    throw new TypeError(`invalid agent conversation id: expected ${AGENT_CONVERSATION_ID_PREFIX}<uuid>`);
  }
  return value as AgentConversationId;
}

