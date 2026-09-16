import { describe, expect, test } from "bun:test";
import {
  AGENT_CONVERSATION_ID_PREFIX,
  AGENT_SESSION_ID_PREFIX,
  createAgentConversationId,
  createAgentSessionId,
  isAgentConversationId,
  isAgentSessionId,
  parseAgentConversationId,
  parseAgentSessionId,
} from "../src/agent-ids.ts";

describe("agent identity primitives", () => {
  test("mints distinct namespaced ids", () => {
    const sessions = [createAgentSessionId(), createAgentSessionId()];
    const conversations = [createAgentConversationId(), createAgentConversationId()];

    expect(sessions[0]).toStartWith(AGENT_SESSION_ID_PREFIX);
    expect(conversations[0]).toStartWith(AGENT_CONVERSATION_ID_PREFIX);
    expect(new Set(sessions).size).toBe(2);
    expect(new Set(conversations).size).toBe(2);
    expect(sessions.every(isAgentSessionId)).toBe(true);
    expect(conversations.every(isAgentConversationId)).toBe(true);
  });

  test("keeps the id namespaces disjoint", () => {
    const sessionId = createAgentSessionId();
    const conversationId = createAgentConversationId();

    expect(isAgentConversationId(sessionId)).toBe(false);
    expect(isAgentSessionId(conversationId)).toBe(false);
  });

  test("parses valid ids and rejects unnamespaced legacy ids", () => {
    const sessionId = createAgentSessionId();
    const conversationId = createAgentConversationId();

    expect(parseAgentSessionId(sessionId)).toBe(sessionId);
    expect(parseAgentConversationId(conversationId)).toBe(conversationId);
    expect(() => parseAgentSessionId("legacy-session-id")).toThrow(TypeError);
    expect(() => parseAgentConversationId("agc-not-a-uuid")).toThrow(TypeError);
  });
});

