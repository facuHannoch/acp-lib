import { expect, spyOn, test } from "bun:test";
import { buildContext, buildSharedContext } from "../src/capabilities/context/build.ts";
import { bindModelAttempt } from "../src/capabilities/model/attempt.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSession } from "../src/index.ts";
import type { ContextEntry } from "../src/contracts/context.ts";
import type { Message } from "../src/contracts/loop.ts";
import type { StoredTurn } from "../src/contracts/storage.ts";
import { ask } from "./helpers/session.ts";

const at = "2026-01-01T00:00:00.000Z";

test("the timeline projection captures inputs and snapshots by value", async () => {
  const session = createSession({ systemPrompt: "system", configureTurn: () => ({ tools: [], executeTool: async () => "unused",
    model: async () => ({ role: "assistant", content: "answer", calls: [] }) }) });
  let notified = 0;
  session.store.subscribe(() => { notified++; });
  session.start();
  await ask(session, { channelId: "a", participantId: "alice", text: "original" });
  const snapshot = session.store.snapshot();
  snapshot[0]!.message.content = "changed";
  expect(session.store.snapshot()[0]).toMatchObject({ seq: 3, from: "alice", turnId: 1, kind: "participant_message",
    message: { content: 'Participant: "alice"\n\noriginal' } });
  expect(notified).toBeGreaterThan(0);
});

test("builder keeps native tool pairs together and excludes other turns' opaque state", () => {
  const entries: ContextEntry[] = [
    { seq: 1, at, channelId: "a", turnId: 1, from: "agent", message: { role: "assistant", content: "External answer", calls: [], providerState: { secret: "opaque-reasoning" } } },
    { seq: 2, at, channelId: "b", turnId: 2, from: "bob", kind: "participant_message", message: { role: "user", content: 'Participant: "bob"\n\nTime?' } },
    { seq: 3, at, channelId: "b", turnId: 2, from: "agent", message: { role: "assistant", content: null, calls: [{ id: "clock", name: "current_time", arguments: "{}" }] } },
    { seq: 4, at, channelId: "a", turnId: 1, from: "alice", message: { role: "user", content: "New fact" } },
    { seq: 5, at, channelId: "b", turnId: 2, from: "tool", message: { role: "tool", content: "now", callId: "clock" } },
  ];
  const context = buildContext(entries, "unchanged system", { channelId: "b", turnId: 2 });
  expect(context[0]).toEqual({ role: "system", content: "unchanged system" });
  expect(context.slice(2).map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(context[1]?.content).toStartWith('Current channel: "b"\nCurrent participant: "bob"\n');
  expect(context[1]?.content).toContain('"from":"alice"');
  expect(context[1]?.content).toContain("New fact");
  expect(JSON.stringify(context)).not.toContain("opaque-reasoning");
  // A turn started by a notice names its source instead of a participant.
  const noticed: ContextEntry[] = [{ seq: 1, at, channelId: "b", turnId: 3, from: "channel:a", kind: "channel_notice", sourceChannelId: "a", message: { role: "user", content: "ping" } }];
  expect(buildContext(noticed, "s", { channelId: "b", turnId: 3 })[1]?.content).toContain('Turn triggered by an internal notice from channel: "a"');
});

test("unfinished turns and their uncertain tool calls are stated in later context; completed turns add nothing", () => {
  const entries: ContextEntry[] = [
    { seq: 2, at, channelId: "a", turnId: 1, from: "alice", kind: "participant_message", message: { role: "user", content: 'Participant: "alice"\n\nDeploy' } },
    { seq: 3, at, channelId: "a", turnId: 1, from: "agent", message: { role: "assistant", content: null, calls: [{ id: "deploy-1", name: "deploy", arguments: "{}" }] } },
  ];
  const turn = (state: StoredTurn["state"]): StoredTurn => ({ turnId: 1, channelId: "a", itemIds: ["i"], startedSeq: 1, startedAt: at, compatibilityKey: "", state });
  const plain = buildSharedContext(entries, "system");
  expect(buildSharedContext(entries, "system", [turn({ status: "completed" })])).toEqual(plain);
  const told = buildSharedContext(entries, "system", [turn({ status: "interrupted", reason: "The owning process exited", uncertainCallIds: ["deploy-1"] })])[1]!.content!;
  expect(told).toStartWith(plain[1]!.content!);
  expect(told).toContain("may or may not have taken effect and was not retried");
  expect(told).toContain('"turnId":1,"outcome":"interrupted","reason":"The owning process exited","uncertainToolCalls":["deploy-1"]');
  // The interrupted exchange stays attributed history: no dangling native tool call.
  const next = buildContext(entries, "system", { channelId: "a", turnId: 2 }, [turn({ status: "interrupted", reason: "x", uncertainCallIds: ["deploy-1"] })]);
  expect(next.map(message => message.role)).toEqual(["system", "user"]);
});

test("every inference rebuilds from committed storage, including continuation after tools", async () => {
  const requests: Message[][] = [];
  const session = createSession({ systemPrompt: "system", configureTurn: turn => ({
    tools: [],
    model: async (messages) => {
      requests.push(structuredClone([...messages]));
      if (turn.channelId === "b" && !messages.some((m) => m.role === "tool")) {
        return { role: "assistant", content: null, calls: [{ id: "t", name: "example", arguments: "{}" }] };
      }
      return { role: "assistant", content: "done", calls: [] };
    },
    executeTool: async () => {
      // A fact recorded on another channel between two inferences of this turn.
      await ask(session, { channelId: "a", participantId: "alice", text: "Design changed" });
      return "result";
    },
  }) });
  session.start();
  await ask(session, { channelId: "a", participantId: "alice", text: "Launch Friday" });
  await ask(session, { channelId: "b", participantId: "bob", text: "What do we know?" });
  const b = requests.filter(request => request[1]?.content?.startsWith('Current channel: "b"'));
  expect(JSON.stringify(b[0])).toContain("Launch Friday");
  expect(JSON.stringify(b[0])).not.toContain("Design changed");
  expect(JSON.stringify(b[1])).toContain("Design changed");
  expect(b[1]?.at(-1)).toEqual({ role: "tool", callId: "t", content: "result" });
});

test("external notice golden context uses host attribution without a participant or source turn", () => {
  const entries: ContextEntry[] = [{ seq: 2, at, channelId: "alice", turnId: 1, from: "worker",
    kind: "external_notice", externalSource: "worker", message: { role: "user", content: "checked" } }];
  const context = buildContext(entries, "system", { channelId: "alice", turnId: 1 });
  expect(context[1]?.content).toStartWith('Current channel: "alice"\nTurn triggered by an external notice\n');
  expect(context[2]).toEqual({ role: "user", content: 'External notice from "worker" to channel "alice":\nchecked' });
  expect(buildSharedContext(entries, "system")[1]?.content).toContain('"externalSource":"worker"');
});

test("admission rejects oversized UTF-8 without records and the take leaves a bounded suffix pending", async () => {
  const batches: string[][] = [];
  const session = createSession({ systemPrompt: "system", captureContext: ({ context }) => {
    batches.push([...context.takenItemIds]);
  }, configureTurn: () => ({
    tools: [], executeTool: async () => "unused",
    model: async () => ({ role: "assistant", content: "answer", calls: [] }),
  }) });
  const input = { channelId: "a", participantId: "alice" };
  const before = session.snapshot();
  expect(session.agent.send({ ...input, text: "é".repeat(4097) })).toMatchObject({ accepted: false, code: "invalid_input" });
  expect(session.snapshot()).toEqual(before);
  const ended = new Promise<void>(resolve => {
    const stop = session.subscribe(({ event }) => { if (event.type === "turn_ended") { stop(); resolve(); } });
  });
  for (let i = 0; i < 17; i++)
    expect(session.agent.send({ ...input, text: "queued", itemId: String(i) }).accepted).toBe(true);
  session.start();
  await ended;
  expect(batches).toEqual([Array.from({ length: 16 }, (_, i) => String(i)), ["16"]]);
  expect(session.snapshot().items.map(item => item.milestone)).toEqual(Array(17).fill("seen"));
});

test("context limit ends the turn before reserving an attempt or marking input seen", async () => {
  let calls = 0;
  const session = createSession({ systemPrompt: "system", configureTurn: () => ({
    tools: [{ name: "large", description: "d".repeat(14000), parameters: {} }],
    executeTool: async () => "unused",
    model: async () => { calls++; return { role: "assistant", content: "answer", calls: [] }; },
  }) });
  const ended = new Promise<void>(resolve => {
    const stop = session.subscribe(({ event }) => { if (event.type === "turn_ended") { stop(); resolve(); } });
  });
  session.start();
  expect(session.agent.send({ channelId: "a", participantId: "alice", text: "small" }).accepted).toBe(true);
  await ended;
  const snapshot = session.snapshot();
  expect(snapshot.turns[0]?.state).toMatchObject({ status: "failed", reason: "context_limit" });
  expect(snapshot.items[0]?.milestone).toBe("taken");
  expect(snapshot.modelCalls).toEqual([]);
  expect(calls).toBe(0);
});

test("a provider retry reuses the request after another channel commits", async () => {
  const attempts: unknown[] = [], revisions: number[] = [];
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "retry", compatibilityKey: "" } });
  if (!opened.ok) throw new Error(opened.error.message);
  const fullSnapshot = spyOn(opened.value, "snapshot");
  const session = createSession({ storage: opened.value, systemPrompt: "system", captureContext: ({ context }) => {
    if (context.channelId === "a") revisions.push(context.timelineRevision);
  }, configureTurn: turn => {
    const answer = { role: "assistant", content: "done", calls: [] } as const;
    const model: import("../src/contracts/loop.ts").Model = async () => ({ ...answer, calls: [] });
    if (turn.channelId === "a") bindModelAttempt(model, { scripted: false, settings: { retryDelayMs: 1 },
      create: (_step, ordinal) => async function* (request) {
        attempts.push(structuredClone(request));
        if (ordinal === 0 && attempts.length === 1) {
          await ask(session, { channelId: "b", participantId: "bob", text: "Correction committed" });
          yield { type: "failure", kind: "transient", message: "retry" };
          return;
        }
        yield { type: "response", response: { ...answer, calls: [], stopReason: "complete" } };
      },
    });
    return { model, tools: [], executeTool: async () => "unused" };
  } });
  session.start();
  await ask(session, { channelId: "a", participantId: "alice", text: "First" });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(JSON.stringify(attempts[1])).not.toContain("Correction committed");
  expect(revisions).toHaveLength(1);
  await ask(session, { channelId: "a", participantId: "alice", text: "Next" });
  expect(revisions[1]).toBeGreaterThan(revisions[0]!);
  expect(JSON.stringify(attempts[2])).toContain("Correction committed");
  expect(fullSnapshot).not.toHaveBeenCalled();
  opened.value.close();
});
