import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createChannelScheduler } from "../src/kernel/channels.ts";
import { createSharedContextStore } from "../src/state/storage/shared-context.ts";
import { sendLocal, serveLocal } from "../src/interfaces/protocol/local.ts";

test("channels run concurrently, preserve separate histories, and queue their own turns", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const store = createSharedContextStore();
  const agent = createChannelScheduler(store, async (input) => {
    started.push(input.text);
    if (input.text === "hold") await gate;
    return input.text;
  });
  const first = agent.send({ channelId: "a", participantId: "alice", text: "hold" });
  const second = agent.send({ channelId: "a", participantId: "bob", text: "next" });
  try {
    expect(await agent.send({ channelId: "b", participantId: "bob", text: "independent" })).toBe("independent");
    expect(started).toEqual(["hold", "independent"]);
  } finally { release(); }
  await Promise.all([first, second]);
  expect(started).toEqual(["hold", "independent", "next"]);
  expect(store.snapshot().filter((e) => e.channelId === "a").map((e) => e.message.content?.split("\n\n")[1])).toEqual(["hold", "next"]);
  expect(store.snapshot().filter((e) => e.channelId === "b")).toHaveLength(1);
});

test("a failed channel stops without blocking another channel", async () => {
  const agent = createChannelScheduler(createSharedContextStore(), async (input) => {
    if (input.channelId === "a") throw new Error("model failed");
    return "ok";
  });
  await expect(agent.send({ channelId: "a", participantId: "alice", text: "first" })).rejects.toThrow("model failed");
  await expect(agent.send({ channelId: "a", participantId: "alice", text: "second" })).rejects.toThrow("Channel stopped");
  expect(await agent.send({ channelId: "b", participantId: "bob", text: "hello" })).toBe("ok");
});

test("Unix HTTP clients reconnect to channel state and malformed input is rejected", async () => {
  const directory = await mkdtemp("/tmp/harness-test-");
  const socket = `${directory}/agent.sock`;
  const store = createSharedContextStore();
  const agent = createChannelScheduler(store, async (input) => store.snapshot()
    .filter((e) => e.channelId === input.channelId && e.message.role === "user")
    .map((e) => `${e.from}:${e.message.content?.split("\n\n")[1]}`).join("|"));
  const server = serveLocal(agent, socket);
  try {
    expect(await sendLocal(socket, { channelId: "a", participantId: "alice", text: "one" })).toBe("alice:one");
    expect(await sendLocal(socket, { channelId: "a", participantId: "bob", text: "two" })).toBe("alice:one|bob:two");
    expect(await sendLocal(socket, { channelId: "b", participantId: "bob", text: "three" })).toBe("bob:three");
    const invalid = await fetch("http://localhost/messages", { unix: socket, method: "POST", body: "{}" });
    expect(invalid.status).toBe(400);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
