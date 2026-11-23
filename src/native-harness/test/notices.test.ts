import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { renderContextEntry } from "../src/capabilities/context/build.ts";
import { executeNotice } from "../src/capabilities/tools/builtin/notify-channel.ts";
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

test("notify tool returns acceptance without waiting", () => {
  const receipt = executeNotice({ channelId: "bob", text: "Stop work" }, (channelId, text) => {
    expect({ channelId, text }).toEqual({ channelId: "bob", text: "Stop work" });
    return { accepted: true, itemId: "auto:3", duplicate: false, milestone: "received" };
  });
  expect(receipt).toEqual({ accepted: true });
  expect(executeNotice({ channelId: "nobody", text: "hi" }, () =>
    ({ accepted: false, code: "not_found", error: "Unknown channel: nobody" })))
    .toEqual({ accepted: false, error: "Unknown channel: nobody" });
});
