import { expect, test } from "bun:test";
import { createChannelScheduler } from "../src/kernel/channels.ts";
import { runTurn } from "../src/kernel/loop.ts";
import { createSharedContextStore } from "../src/state/storage/shared-context.ts";
import { buildContext, renderContextEntry } from "../src/capabilities/context/build.ts";
import { createDashboardWork } from "../src/capabilities/tools/dashboard.ts";
import { createScenarioTools } from "../src/capabilities/tools/scenario.ts";
import type { Agent } from "../src/contracts/agent.ts";

test("notices during inference keep the turn alive and are consumed once, without a pass limit", async () => {
  const store = createSharedContextStore();
  let calls = 0;
  let agent: Agent;
  agent = createChannelScheduler(store, (input, mailbox) => runTurn({
    drainNotices: mailbox.drain, finish: mailbox.finish,
    build: () => buildContext(store.snapshot(), "system", input),
    append(message) { store.append({ channelId: input.channelId, turnId: input.turnId, from: "agent", message }); },
  }, async messages => {
    calls++;
    if (calls > 1) expect(messages.some(m => m.content?.includes(`Notice ${calls - 1}`))).toBe(true);
    if (calls < 4) expect(agent.notify({ channelId: input.channelId, fromChannelId: "charlie", text: `Notice ${calls}` })).toEqual({ accepted: true, delivery: "inbox" });
    return { role: "assistant", content: "done", calls: [] };
  }, [], async () => "unused"));
  expect(await agent.send({ channelId: "bob", participantId: "bob", text: "work" })).toBe("done");
  expect(calls).toBe(4);
  expect(store.snapshot().filter(e => e.from === "channel:charlie")).toHaveLength(3);
  expect(store.snapshot().filter(e => e.kind === "channel_notice").every(e => e.sourceChannelId === "charlie")).toBe(true);
});

test("notice after finish closes admission starts a new turn without falling through the boundary", async () => {
  const store = createSharedContextStore();
  let agent: Agent;
  let completion: Promise<string> | undefined;
  const turns: number[] = [];
  agent = createChannelScheduler(store, async (input, mailbox) => {
    turns.push(input.turnId);
    expect(mailbox.finish()).toBe(true);
    if (turns.length === 1) {
      const receipt = agent.notify({ channelId: "bob", fromChannelId: "charlie", text: "Stop work" });
      expect(receipt.accepted && receipt.delivery).toBe("turn");
      if (receipt.accepted) completion = receipt.completion;
    }
    return "done";
  });
  await agent.send({ channelId: "bob", participantId: "bob", text: "hello" });
  await completion;
  expect(turns).toHaveLength(2);
  const receipt = agent.notify({ channelId: "bob", fromChannelId: "charlie", text: "Idle notice" });
  expect(receipt.accepted && receipt.delivery).toBe("turn");
  if (receipt.accepted) await receipt.completion;
  expect(turns).toHaveLength(3);
  const notices = store.snapshot().filter(e => e.kind === "channel_notice");
  expect(notices).toHaveLength(2);
  expect(notices[0]?.message.content).toBe("Stop work");
  const rendered = renderContextEntry(notices[0]!);
  expect(rendered.content).toContain('Internal notice from channel "charlie"');
  expect(rendered.content).not.toContain('Participant:');
  expect(agent.notify({ channelId: "missing", fromChannelId: "charlie", text: "hello" }).accepted).toBe(false);
});

test("dashboard is shared, progresses one step per inference and rejects invalid arguments", async () => {
  let waits = 0;
  const dashboard = createDashboardWork(async () => { waits++; });
  const tools = createScenarioTools({ channelId: "alice", participantId: "alice", turnId: 1, text: "work" }, dashboard,
    () => ({ accepted: true, delivery: "inbox" }));
  expect(JSON.parse(await tools.execute({ id: "invalid", name: "dashboard_work", arguments: '{"seconds":0}' })).ok).toBe(false);
  for (let i = 1; i <= 5; i++) {
    tools.beginInference();
    const step = JSON.parse(await tools.execute({ id: String(i), name: "dashboard_work", arguments: "{}" }));
    expect(step).toMatchObject({ channelId: "alice", turnId: 1, completedSteps: i, totalSteps: 5 });
    expect(JSON.parse(await tools.execute({ id: "duplicate", name: "dashboard_work", arguments: "{}" })).ok).toBe(false);
  }
  tools.beginInference();
  expect(JSON.parse(await tools.execute({ id: "done", name: "dashboard_work", arguments: "{}" })).status).toBe("completed");
  expect(waits).toBe(5);
});

test("notify tool supplies source identity and returns acceptance without waiting", async () => {
  const tools = createScenarioTools({ channelId: "charlie", participantId: "c", turnId: 7, text: "stop" }, createDashboardWork(), notice => {
    expect(notice).toEqual({ channelId: "bob", fromChannelId: "charlie", text: "Stop work" });
    return { accepted: true, delivery: "turn", completion: new Promise(() => {}) };
  });
  expect(JSON.parse(await tools.execute({ id: "n", name: "notify_channel", arguments: '{"channelId":"bob","text":"Stop work"}' })))
    .toEqual({ accepted: true, delivery: "turn" });
});

test("simultaneous dashboard attempts cannot advance the same step twice", async () => {
  let release!: () => void;
  const dashboard = createDashboardWork(() => new Promise<void>(resolve => { release = resolve; }));
  const input = { channelId: "a", participantId: "alice", turnId: 1, text: "work" };
  const pending = dashboard(input);
  expect(await dashboard({ ...input, channelId: "b" })).toMatchObject({ ok: false, status: "busy", completedSteps: 0 });
  release();
  expect(await pending).toMatchObject({ completedSteps: 1, channelId: "a" });
});
