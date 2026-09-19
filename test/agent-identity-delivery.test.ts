import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/identity-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent identity delivery", () => {
  test("delivers cross-conversation context once and reuses cursors after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-agent-identity-"));
    directories.push(directory);
    const path = join(directory, "agent.sqlite");
    let agent = await open(path);
    const source = await agent.conversations.create();
    await source.prompt("SOURCE_FIRST_FACT");
    const target = await agent.conversations.create();
    const first = await target.prompt("target first");
    expect(JSON.parse(first.text)).toMatchObject({ sawFirst: true, hasSourceContext: true });
    const providerContextId = target.internalSessionId!;
    expect((await agent.persistence.identityDelivery!.get(target.id, providerContextId, source.id))?.deliveredThroughSequence)
      .toBeGreaterThan(0);

    const second = await target.prompt("target second");
    expect(JSON.parse(second.text).sawFirst).toBe(false);
    await source.prompt("SOURCE_NEW_FACT");
    const third = await target.prompt("target third");
    expect(JSON.parse(third.text)).toMatchObject({ sawNew: true, sawFirst: false });

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    agent = await open(path);
    const loaded = await agent.conversations.open(target.id);
    expect(loaded.providerSession).toBe("loaded");
    expect(loaded.conversation.internalSessionId).toBe(providerContextId);
    const afterReopen = await loaded.conversation.prompt("target reopened");
    expect(JSON.parse(afterReopen.text)).toMatchObject({ sawFirst: false, sawNew: false });

    const oldProviderContextId = loaded.conversation.internalSessionId;
    await loaded.conversation.reset();
    expect(loaded.conversation.internalSessionId).not.toBe(oldProviderContextId);
    const freshThread = await loaded.conversation.prompt("target after reset");
    expect(JSON.parse(freshThread.text)).toMatchObject({ sawFirst: true, sawNew: true });
  }, 20_000);

  test("does not advance a cursor after a failed provider prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-agent-identity-"));
    directories.push(directory);
    const agent = await open(join(directory, "agent.sqlite"));
    const source = await agent.conversations.create();
    await source.prompt("SOURCE_RETRY_FACT");
    const target = await agent.conversations.create();
    await expect(target.prompt("FAIL_IDENTITY_TURN")).rejects.toThrow("intentional identity fixture failure");
    expect(await agent.persistence.identityDelivery!.get(target.id, target.internalSessionId!, source.id)).toBeNull();
    const retried = await target.prompt("target retry");
    expect(JSON.parse(retried.text).sawRetry).toBe(true);
  }, 20_000);
});

async function open(path: string): Promise<Agent> {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { fixture: { command: ["bun", FIXTURE] } },
    defaultAdapterId: "fixture",
    identity: { kind: "checkpoint-backed" },
    checkpointing: { schedule: { milestones: [1_000], everyAfterMilestones: 1_000 } },
  });
  agents.push(agent);
  return agent;
}
