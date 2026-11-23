import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, NotConnectedError } from "../src/index.ts";
import type { AgentConfig, ProviderStart } from "../src/index.ts";
import { nativeRig } from "./native/support.ts";

const lifecycle = new URL("./fixtures/lifecycle-agent.ts", import.meta.url).pathname;
const configurable = new URL("./fixtures/config-agent.ts", import.meta.url).pathname;

async function fixture(providerStart?: ProviderStart, peer = lifecycle) {
  const directory = await mkdtemp(join(tmpdir(), "acp-provider-start-"));
  const calls: Array<{ method: string; params?: { sessionId?: string } }> = [];
  const config: AgentConfig = {
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { sample: { command: [process.execPath, peer] } },
    checkpointing: { enabled: false },
    conversationDefaults: {
      ...(providerStart ? { providerStart } : {}),
      env: { LIFECYCLE_STATE: join(directory, "sessions.json") },
      wire(entry) { if (entry.dir === "out") calls.push(JSON.parse(entry.line)); },
    },
  };
  return { config, calls, directory, methods: () => calls.map(call => call.method) };
}

test("ACP defaults to eager startup and runtime overrides only affect new handles", async () => {
  const rig = await fixture();
  const agent = await Agent.open(rig.config);
  try {
    const eager = await agent.conversations.create();
    expect(eager.connection.isConnected).toBe(true);
    expect(rig.methods()).toContain("session/new");
    rig.calls.length = 0;
    const lazy = await agent.conversations.create({ runtime: { providerStart: "on_first_use" } });
    expect((await agent.conversations.open(lazy.id, { runtime: { providerStart: "on_open" } })).providerSession).toBe("already_open");
    expect(lazy.connection.isConnected).toBe(false);
    expect(lazy.configOptions.size).toBe(0);
    expect(lazy.internalSessionCommands).toHaveLength(0);
    expect(lazy.model).toBeNull();
    expect(() => lazy.capabilities).toThrow(NotConnectedError);
    await agent.conversations.list();
    await lazy.stop();
    expect(rig.calls).toEqual([]);
    const opened = await agent.conversations.open(lazy.id, { runtime: { providerStart: "on_first_use" } });
    expect(opened.providerSession).toBe("deferred");
    expect(opened.conversation.internalSessionId).toBeNull();
    const events: string[] = [];
    opened.conversation.subscribe(({ event }) => { if (event.kind === "provider_reconnected") events.push(event.via); });
    const results = await Promise.all([
      opened.conversation.prompt("first use"),
      opened.conversation.prompt({ text: "queued use", delivery: "queue" }),
    ]);
    expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
    expect(rig.methods().filter(method => method === "initialize")).toHaveLength(1);
    expect(rig.methods().filter(method => method === "session/new")).toHaveLength(1);
    expect(events).toEqual(["fresh"]);
  } finally {
    await agent.close();
    await rm(rig.directory, { recursive: true, force: true });
  }
});

test("Agent lazy defaults start on a settings write and on_open overrides the default", async () => {
  const rig = await fixture("on_first_use", configurable);
  const agent = await Agent.open(rig.config);
  try {
    const lazy = await agent.conversations.create();
    expect(rig.calls).toEqual([]);
    await lazy.setConfig("model", "beta");
    expect(lazy.model).toBe("beta");
    expect(rig.methods()).toEqual(["initialize", "session/new", "session/set_config_option"]);
    const eager = await agent.conversations.create({ runtime: { providerStart: "on_open" } });
    expect(eager.connection.isConnected).toBe(true);
  } finally {
    await agent.close();
    await rm(rig.directory, { recursive: true, force: true });
  }
});

test("a deferred reopen keeps the recorded session and loads it on first use", async () => {
  const rig = await fixture();
  let agent = await Agent.open(rig.config);
  try {
    const first = await agent.conversations.create();
    await first.prompt("recorded context");
    const internalSessionId = first.internalSessionId!;
    await agent.close();
    rig.calls.length = 0;
    agent = await Agent.open(rig.config);
    const { conversation, providerSession } = await agent.conversations.open(first.id, { runtime: { providerStart: "on_first_use" } });
    expect(providerSession).toBe("deferred");
    expect(conversation.internalSessionId).toBe(internalSessionId);
    expect(conversation.connection.isConnected).toBe(false);
    expect(rig.calls).toEqual([]);
    expect((await conversation.prompt("use recorded provider")).text).toContain("recorded context");
    expect(rig.calls.find(call => call.method === "session/load")?.params?.sessionId).toBe(internalSessionId);
    expect(rig.methods()).not.toContain("session/new");
  } finally {
    await agent.close();
    await rm(rig.directory, { recursive: true, force: true });
  }
});

for (const failure of ["launch", "authentication"] as const) {
  test(`lazy startup reports a provider ${failure} failure on first use`, async () => {
    const rig = await fixture("on_first_use");
    const agent = await Agent.open({
      ...rig.config,
      ...(failure === "launch" ? { adapters: { sample: { command: [join(rig.directory, "missing-command")] } } } : {}),
      conversationDefaults: { ...rig.config.conversationDefaults, env: { LIFECYCLE_FAIL_CONTROL: "session/new" } },
    });
    try {
      const conversation = await agent.conversations.create();
      expect(rig.calls).toEqual([]);
      await expect(conversation.prompt("first use")).rejects.toBeInstanceOf(Error);
      expect(conversation.internalSessionId).toBeNull();
      expect(conversation.connection.isConnected).toBe(false);
      expect(rig.methods()).not.toContain("session/prompt");
      if (failure === "authentication") expect(rig.methods()).toEqual(["initialize", "session/new"]);
    } finally {
      await agent.close();
      await rm(rig.directory, { recursive: true, force: true });
    }
  });
}

test("providerStart remains an ACP-only option and native open stays detached", async () => {
  const rig = await nativeRig();
  try {
    const agent = await rig.open({ conversationDefaults: { providerStart: "on_first_use" } });
    const conversation = await agent.conversations.create();
    await conversation.stop();
    const reopened = await agent.conversations.open(conversation.id);
    expect(reopened.providerSession).toBe("new");
    expect(agent.nativeHarness!.launches).toBe(0);
  } finally { await rig.clean(); }
});
