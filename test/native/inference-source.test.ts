import { expect, test } from "bun:test";
import type { AgentHarnessConfig } from "../../src/agent/config.ts";
import { createAgentConversationId, createAgentSessionId } from "../../src/agent-ids.ts";
import { noopLogger } from "../../src/logger.ts";
import { openOrCreate } from "../../src/native/recovery.ts";
import { ReminderSync } from "../../src/native/reminders/sync.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";
import { RoutinePeer } from "./fixtures/routine-peer.ts";

type Model = AgentHarnessConfig["config"]["model"];

// Compile-time: the public config accepts every ManagedModel arm of the harness SDK, without casts.
const arms = [
  { protocol: "scripted", script: "/tmp/scenario.jsonl" },
  { protocol: "openrouter", model: "openai/gpt-6-luna", apiKeyEnv: "OPENROUTER_API_KEY" },
  { protocol: "opencode-go", model: "deepseek-v4.1-flash" },
  { protocol: "openai-compatible", providerId: "local", model: "qwen2.5-coder", baseUrl: "http://127.0.0.1:11434/v1" },
  { protocol: "openai-compatible", providerId: "gateway", model: "gpt-4.1", baseUrl: "https://llm.example.com/v1", apiKeyEnv: "GATEWAY_KEY" },
] satisfies Model[];

test("an openai-compatible model reaches session create and open unchanged", async () => {
  for (const model of arms) {
    const agentSessionId = createAgentSessionId();
    const channel = createAgentConversationId();
    const persistence = await SqliteAgentPersistence.open({ path: ":memory:", agentSessionId });
    try {
      await persistence.conversations.create({ agentSessionId, agentConversationId: channel, controllerKind: "native" });
      const sync = new ReminderSync(persistence, persistence.reminders, noopLogger);
      const peer = new RoutinePeer();
      await sync.initialize({ capabilities: { reminders: true } });
      const config = { version: 1 as const, system: "test", model, defaultPolicy: "open", policies: { open: { fallback: "allow" as const, tools: {} } } };
      await openOrCreate(peer.client, { sessionId: peer.sessionId, config },
        [{ channel, changeId: "1", displayName: "channel" }], undefined, new AbortController().signal, sync);
      const sent = peer.calls.filter(call => call.method === "create" || call.method === "open");
      expect(sent.length).toBeGreaterThan(0);
      for (const call of sent) expect((call.params as { config?: unknown }).config).toMatchObject({ model });
    } finally { await persistence.close(); }
  }
});
