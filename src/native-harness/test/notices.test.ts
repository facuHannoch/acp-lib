import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { renderContextEntry } from "../src/capabilities/context/build.ts";
import { createDashboardWork } from "../src/capabilities/tools/dashboard.ts";
import { createScenarioTools } from "../src/capabilities/tools/scenario.ts";
import { ask, turnsEnd } from "./helpers/session.ts";

test("notices during inference keep the turn alive and are consumed once, without a pass limit", async () => {
  let calls = 0;
  const session = createSession({ systemPrompt: "system", configureTurn: turn => ({ tools: [], executeTool: async () => "unused",
    model: async messages => {
      calls++;
      if (calls > 1) expect(messages.some(m => m.content?.includes(`Notice ${calls - 1}`))).toBe(true);
      if (calls < 4) expect(session.agent.notify({ channelId: turn.channelId, fromChannelId: "charlie", text: `Notice ${calls}` }))
        .toMatchObject({ accepted: true, duplicate: false, milestone: "received" });
      return { role: "assistant", content: "done", calls: [] };
    } }) });
  session.start();
  expect(await ask(session, { channelId: "bob", participantId: "bob", text: "work" })).toBe("done");
  expect(calls).toBe(4);
  expect(session.store.snapshot().filter(e => e.from === "channel:charlie")).toHaveLength(3);
  expect(session.store.snapshot().filter(e => e.kind === "channel_notice").every(e => e.sourceChannelId === "charlie")).toBe(true);
  expect(session.snapshot().turns).toHaveLength(1);
  expect(session.snapshot().turns[0]!.itemIds).toHaveLength(4);
});

test("a notice that arrives as its target turn completes reaches exactly one later turn", async () => {
  const requests: number[] = [];
  const session = createSession({ systemPrompt: "system", configureTurn: turn => ({ tools: [], executeTool: async () => "unused",
    model: async () => { requests.push(turn.turnId); return { role: "assistant", content: "done", calls: [] }; } }) });
  session.start();
  // The earliest possible moment after the finish commit: its own event.
  let raced = false;
  session.subscribe(({ event }) => {
    if (event.type !== "turn_ended" || raced) return;
    raced = true;
    expect(session.agent.notify({ channelId: "bob", fromChannelId: "charlie", text: "Stop work" })).toMatchObject({ accepted: true });
  });
  const log = turnsEnd(session, 2);
  session.agent.send({ channelId: "bob", participantId: "bob", text: "hello" });
  await log.done;
  expect(requests).toEqual([1, 2]);
  const idle = turnsEnd(session);
  expect(session.agent.notify({ channelId: "bob", fromChannelId: "charlie", text: "Idle notice" })).toMatchObject({ accepted: true });
  await idle.done;
  expect(requests).toEqual([1, 2, 3]);
  const notices = session.store.snapshot().filter(e => e.kind === "channel_notice");
  expect(notices.map(e => [e.turnId, e.message.content])).toEqual([[2, "Stop work"], [3, "Idle notice"]]);
  expect(session.snapshot().items.filter(item => item.kind === "channel_notice").map(item => item.turnId)).toEqual([2, 3]);
  const rendered = renderContextEntry(notices[0]!);
  expect(rendered.content).toContain('Internal notice from channel "charlie"');
  expect(rendered.content).not.toContain('Participant:');
  expect(session.agent.notify({ channelId: "missing", fromChannelId: "charlie", text: "hello" }).accepted).toBe(false);
});

test("dashboard is shared, progresses one step per inference and rejects invalid arguments", async () => {
  let waits = 0;
  const dashboard = createDashboardWork(async () => { waits++; });
  const tools = createScenarioTools({ channelId: "alice", turnId: 1 }, dashboard,
    () => ({ accepted: true, itemId: "auto:1", duplicate: false, milestone: "received" }));
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
  const tools = createScenarioTools({ channelId: "charlie", turnId: 7 }, createDashboardWork(), notice => {
    expect(notice).toEqual({ channelId: "bob", fromChannelId: "charlie", text: "Stop work" });
    return { accepted: true, itemId: "auto:3", duplicate: false, milestone: "received" };
  });
  expect(JSON.parse(await tools.execute({ id: "n", name: "notify_channel", arguments: '{"channelId":"bob","text":"Stop work"}' })))
    .toEqual({ accepted: true });
  const refusing = createScenarioTools({ channelId: "charlie", turnId: 7 }, createDashboardWork(),
    () => ({ accepted: false, code: "not_found", error: "Unknown channel: nobody" }));
  expect(JSON.parse(await refusing.execute({ id: "n", name: "notify_channel", arguments: '{"channelId":"nobody","text":"hi"}' })))
    .toEqual({ accepted: false, error: "Unknown channel: nobody" });
});

test("simultaneous dashboard attempts cannot advance the same step twice", async () => {
  let release!: () => void;
  const dashboard = createDashboardWork(() => new Promise<void>(resolve => { release = resolve; }));
  const input = { channelId: "a", turnId: 1 };
  const pending = dashboard(input);
  expect(await dashboard({ ...input, channelId: "b" })).toMatchObject({ ok: false, status: "busy", completedSteps: 0 });
  release();
  expect(await pending).toMatchObject({ completedSteps: 1, channelId: "a" });
});
