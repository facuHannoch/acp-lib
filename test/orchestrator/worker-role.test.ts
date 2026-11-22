import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Agent, type AgentConfig } from "../../src/index.ts";

const fixture = resolve(import.meta.dir, "../fixtures/echo-prompt-agent.ts");

async function open(config: Partial<AgentConfig> = {}) {
  return Agent.open({
    persistence: { kind: "sqlite", path: ":memory:" },
    adapters: { echo: { command: ["bun", fixture] } },
    capture: { message: "content" },
    checkpointing: { schedule: { milestones: [1_000], everyAfterMilestones: 1_000 } },
    ...config,
  });
}

test("a worker is listed by role and keeps its transcript out of identity across reopen", async () => {
  const loaded: string[] = [], updated: string[] = [];
  const agent = await open({ identity: {
    async load(input) { loaded.push(input.agentConversationId); return { promptPreamble: "private identity" }; },
    async update(input) { updated.push(input.agentConversationId); },
  } });
  try {
    const worker = await agent.conversations.create({ role: "worker" });
    expect(JSON.parse((await worker.prompt("worker task")).text)).toEqual({ prompt: "worker task" });
    await agent.conversations.appendAssistantMessage(worker.id, { text: "written out of band" });
    await worker.stop();
    const { conversation: reopened } = await agent.conversations.open(worker.id);
    expect((await reopened.prompt("worker next")).text).not.toContain("private identity");
    const ordinary = await agent.conversations.create();
    expect((await ordinary.prompt("ordinary")).text).toContain("private identity");
    expect(loaded).toEqual([ordinary.id]);
    expect(updated.length).toBeGreaterThan(0);
    expect(new Set(updated)).toEqual(new Set([ordinary.id]));
    expect((await agent.conversations.list()).conversations.find(row => row.agentConversationId === worker.id)?.role).toBe("worker");
  } finally {
    await agent.close();
  }
}, 20_000);

test("checkpoint-backed identity skips a worker as a source", async () => {
  const agent = await open({ identity: { kind: "checkpoint-backed" } });
  try {
    const worker = await agent.conversations.create({ role: "worker" });
    await worker.prompt("WORKER ONLY FACT");
    const source = await agent.conversations.create();
    await source.prompt("ORDINARY SOURCE FACT");
    const target = await agent.conversations.create();
    const result = await target.prompt("show context");
    expect(result.text).toContain("ORDINARY SOURCE FACT");
    expect(result.text).not.toContain("WORKER ONLY FACT");
  } finally {
    await agent.close();
  }
}, 20_000);

test("worker creation rejects a per-conversation capture override that would discard its result", async () => {
  const agent = await open({
    conversationPersistence: context => context.role === "worker" ? { capture: { message: "none" } } : undefined,
  });
  try {
    await expect(agent.conversations.create({ role: "worker" })).rejects.toThrow('require message capture "content"');
    expect((await agent.conversations.list()).conversations).toEqual([]);
  } finally {
    await agent.close();
  }
});
