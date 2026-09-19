import { describe, expect, test } from "bun:test";
import { AgentConversation, AgentSession } from "../src/index.ts";
import { AgentConversation as DirectAgentConversation } from "../src/agent-conversation.ts";

describe("AgentConversation compatibility boundary", () => {
  test("AgentSession and AgentConversation are the same constructor", () => {
    expect(AgentConversation).toBe(AgentSession);
    expect(DirectAgentConversation).toBe(AgentConversation);
  });

  test("static factories are exposed through both names", () => {
    expect(AgentConversation.create).toBe(AgentSession.create);
    expect(AgentConversation.open).toBe(AgentSession.open);
  });
});
