import { expect, test } from "bun:test";
import { createSharedContextStore } from "../src/state/storage/shared-context.ts";
import { buildContext } from "../src/capabilities/context/build.ts";
import { createChannelScheduler } from "../src/kernel/channels.ts";
import { runTurn } from "../src/kernel/loop.ts";
import type { Message } from "../src/contracts/loop.ts";

test("store captures inputs and snapshots by value", () => {
  const store = createSharedContextStore();
  const message: Message = { role: "user", content: "original" };
  store.append({ channelId: "a", turnId: 1, from: "alice", message });
  message.content = "changed";
  const snapshot = store.snapshot();
  snapshot[0]!.message.content = "also changed";
  expect(store.snapshot()[0]).toMatchObject({ seq: 1, from: "alice", message: { content: "original" } });
});

test("builder keeps native tool pairs together and excludes other turns' opaque state", () => {
  const store = createSharedContextStore();
  store.append({ channelId: "a", turnId: 1, from: "agent", message: {
    role: "assistant", content: "External answer", calls: [], providerState: { secret: "opaque-reasoning" },
  } });
  store.append({ channelId: "b", turnId: 2, from: "agent", message: {
    role: "assistant", content: null, calls: [{ id: "clock", name: "current_time", arguments: "{}" }],
  } });
  store.append({ channelId: "a", turnId: 1, from: "alice", message: { role: "user", content: "New fact" } });
  store.append({ channelId: "b", turnId: 2, from: "tool", message: { role: "tool", content: "now", callId: "clock" } });
  const input = { channelId: "b", turnId: 2, participantId: "bob", text: "Time?" };
  const context = buildContext(store.snapshot(), "unchanged system", input);
  expect(context[0]).toEqual({ role: "system", content: "unchanged system" });
  expect(context.slice(2).map((m) => m.role)).toEqual(["assistant", "tool"]);
  expect(context[1]?.content).toContain('"from":"alice"');
  expect(context[1]?.content).toContain("New fact");
  expect(JSON.stringify(context)).not.toContain("opaque-reasoning");
});

test("every inference rebuilds from the shared store, including continuation after tools", async () => {
  const store = createSharedContextStore();
  const requests: Message[][] = [];
  const agent = createChannelScheduler(store, async (input) => runTurn({
    append(message) { store.append({ channelId: input.channelId, turnId: input.turnId, from: message.role, message }); },
    build: () => buildContext(store.snapshot(), "system", input),
  }, async (messages) => {
    requests.push(structuredClone([...messages]));
    if (input.channelId === "b" && !messages.some((m) => m.role === "tool")) {
      return { role: "assistant", content: null, calls: [{ id: "t", name: "example", arguments: "{}" }] };
    }
    return { role: "assistant", content: "done", calls: [] };
  }, [], async () => {
    // Model a newly recorded fact between ordinary inference calls, without
    // implementing notifications or a concurrent scheduling scenario yet.
    store.append({ channelId: "a", turnId: 3, from: "alice", message: { role: "user", content: "Design changed" } });
    return "result";
  }));
  await agent.send({ channelId: "a", participantId: "alice", text: "Launch Friday" });
  await agent.send({ channelId: "b", participantId: "bob", text: "What do we know?" });
  expect(JSON.stringify(requests[1])).toContain("Launch Friday");
  expect(JSON.stringify(requests[1])).not.toContain("Design changed");
  expect(JSON.stringify(requests[2])).toContain("Design changed");
  expect(requests[2]?.at(-1)).toEqual({ role: "tool", callId: "t", content: "result" });
});
