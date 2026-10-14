import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AcpLauncher, type AgentConversationId } from "../src/index.ts";
import { createAgentConversationId } from "../src/agent-ids.ts";
import {
  isOpenCode,
  openCodeConfigWithoutTitle,
  withoutHarnessBackgroundWork,
} from "../src/internal-inference/runtime/disposable-session-env.ts";

const REPLAY_AGENT = resolve(import.meta.dir, "fixtures/replay-agent.ts");
const CONFIG = "OPENCODE_CONFIG_CONTENT";
const directories: string[] = [];
const agents: Agent[] = [];
const savedConfig = process.env[CONFIG];

afterEach(async () => {
  if (savedConfig === undefined) delete process.env[CONFIG];
  else process.env[CONFIG] = savedConfig;
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("openCodeConfigWithoutTitle", () => {
  test("disables the title agent in an empty config", () => {
    expect(JSON.parse(openCodeConfigWithoutTitle(undefined)!)).toEqual({ agent: { title: { disable: true } } });
    expect(JSON.parse(openCodeConfigWithoutTitle("  ")!)).toEqual({ agent: { title: { disable: true } } });
  });

  test("keeps everything else the consumer configured", () => {
    const merged = JSON.parse(openCodeConfigWithoutTitle(JSON.stringify({
      model: "x/y",
      agent: { build: { model: "a/b" }, title: { model: "small/one" } },
    }))!);
    expect(merged).toEqual({
      model: "x/y",
      agent: { build: { model: "a/b" }, title: { model: "small/one", disable: true } },
    });
  });

  test("leaves config it cannot read alone, so the consumer's mistake is not hidden", () => {
    expect(openCodeConfigWithoutTitle("{not json")).toBeUndefined();
    expect(openCodeConfigWithoutTitle("[1]")).toBeUndefined();
  });
});

describe("withoutHarnessBackgroundWork", () => {
  const opencode = { command: ["opencode", "acp"] };

  test("recognizes OpenCode by id or by command", () => {
    expect(isOpenCode("opencode", { command: ["whatever"] })).toBe(true);
    expect(isOpenCode("mine", { command: ["/usr/local/bin/opencode", "acp"] })).toBe(true);
    expect(isOpenCode("codex", { command: ["codex-acp"] })).toBe(false);
  });

  test("another harness is not touched", () => {
    const launch = { env: { A: "1" } };
    expect(withoutHarnessBackgroundWork("codex", { command: ["codex-acp"] }, launch)).toBe(launch);
  });

  test("without a launcher the variable joins the consumer's env", () => {
    delete process.env[CONFIG];
    const out = withoutHarnessBackgroundWork("opencode", opencode, { env: { A: "1" } });
    expect(out.env!.A).toBe("1");
    expect(JSON.parse(out.env![CONFIG]!)).toEqual({ agent: { title: { disable: true } } });
  });

  test("it builds on the config the process already has when the consumer's env does not set one", () => {
    process.env[CONFIG] = JSON.stringify({ model: "from/process" });
    const out = withoutHarnessBackgroundWork("opencode", opencode, {});
    expect(JSON.parse(out.env![CONFIG]!)).toEqual({ model: "from/process", agent: { title: { disable: true } } });
  });

  test("with a launcher, its spawnEnv gets the variable and keeps what it had", async () => {
    const launcher: AcpLauncher = {
      async prepare() {
        return { command: ["opencode", "acp"], spawnEnv: { KEPT: "yes", [CONFIG]: JSON.stringify({ model: "m/n" }) } };
      },
    };
    const out = withoutHarnessBackgroundWork("opencode", opencode, { env: { IGNORED: "1" }, launcher });
    expect(out.env).toEqual({ IGNORED: "1" });
    const prepared = await out.launcher!.prepare({ kind: "acp", targetCommand: ["opencode", "acp"] });
    expect(prepared.spawnEnv.KEPT).toBe("yes");
    expect(JSON.parse(prepared.spawnEnv[CONFIG]!)).toEqual({ model: "m/n", agent: { title: { disable: true } } });
  });
});

describe("the default internal-inference runtime", () => {
  async function open(options: { suppress?: boolean; env?: Record<string, string> } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "acp-disposable-"));
    directories.push(directory);
    delete process.env[CONFIG];
    // Other test files configure the shared fixture through the process environment and leave it set.
    for (const key of Object.keys(process.env)) if (key.startsWith("REPLAY_AGENT_")) delete process.env[key];
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { opencode: { command: ["bun", REPLAY_AGENT] } },
      defaultAdapterId: "opencode",
      conversationDefaults: { metering: { pricing: false }, ...(options.env ? { env: options.env } : {}) },
      checkpointing: { schedule: { milestones: [1000], everyAfterMilestones: 1000 } },
      ...(options.suppress === undefined ? {} : { internalInference: { suppressHarnessBackgroundWork: options.suppress } }),
    });
    agents.push(agent);
    return agent;
  }

  /** What the disposable session's process was started with, as the checkpoint summary reports it. */
  async function configSeenByCheckpoint(agent: Agent): Promise<string> {
    const conversationId: AgentConversationId = createAgentConversationId();
    await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: conversationId });
    await agent.persistence.records.appendMany([
      {
        recordId: "m-user", agentSessionId: agent.id, agentConversationId: conversationId, kind: "message",
        timestamp: new Date().toISOString(), role: "user", content: "ECHO_OPENCODE_CONFIG",
      },
      {
        recordId: "m-assistant", agentSessionId: agent.id, agentConversationId: conversationId, kind: "message",
        timestamp: new Date().toISOString(), role: "assistant", content: "ok",
      },
    ]);
    await agent.checkpointing!.request(conversationId);
    const deadline = Date.now() + 10_000;
    let latest = await agent.checkpointing!.latest(conversationId);
    while (!latest && Date.now() < deadline) {
      await Bun.sleep(25);
      latest = await agent.checkpointing!.latest(conversationId);
    }
    return latest?.summary ?? "no checkpoint";
  }

  test("an OpenCode checkpoint session starts with the title agent disabled", async () => {
    const agent = await open();
    const seen = await configSeenByCheckpoint(agent);
    expect(seen.startsWith("ENV=")).toBe(true);
    expect(JSON.parse(seen.slice(4))).toEqual({ agent: { title: { disable: true } } });
  });

  test("the consumer's own OpenCode config is kept", async () => {
    const agent = await open({ env: { [CONFIG]: JSON.stringify({ model: "mine/model" }) } });
    expect(JSON.parse((await configSeenByCheckpoint(agent)).slice(4))).toEqual({
      model: "mine/model",
      agent: { title: { disable: true } },
    });
  });

  test("a conversation's own session is not changed", async () => {
    const agent = await open();
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("ECHO_OPENCODE_CONFIG");
    expect(result.messages.map((message) => message.text)).toEqual(["ENV=unset"]);
  });

  test("suppressHarnessBackgroundWork: false leaves the harness as configured", async () => {
    const agent = await open({ suppress: false });
    expect(await configSeenByCheckpoint(agent)).toBe("ENV=unset");
  });
});
