import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createChannelOutputs, publishChannelEvent } from "../src/interfaces/protocol/output.ts";
import { serveLocal, sendLocal } from "../src/interfaces/protocol/local.ts";
import { subscribeLocal } from "../src/interfaces/protocol/subscribe.ts";
import { createSession } from "../src/index.ts";
import type { ChannelOutput } from "../src/contracts/output.ts";

test("channel subscription delivers own and notice-started replies once, isolated by channel", async () => {
  const directory = await mkdtemp("/tmp/harness-output-");
  const socket = `${directory}/agent.sock`;
  const outputs = createChannelOutputs();
  const session = createSession({ systemPrompt: "test", configureTurn: input => ({
    model: async () => ({ role: "assistant", content: `Answer: ${input.text}`, calls: [] }),
    tools: [], executeTool: async () => "unused",
  }) });
  session.subscribe(event => publishChannelEvent(outputs, event));
  const agent = session.agent;
  const server = serveLocal(agent, socket, outputs);
  const received: ChannelOutput[] = [];
  let resolve!: () => void;
  let delivery = new Promise<void>(r => { resolve = r; });
  const subscription = await subscribeLocal(socket, "bob", event => { received.push(event); resolve(); });
  try {
    await sendLocal(socket, { channelId: "alice", participantId: "alice", text: "other" });
    expect(received).toHaveLength(0);
    expect(await sendLocal(socket, { channelId: "bob", participantId: "bob", text: "hello" })).toBe("Answer: hello");
    await delivery;
    expect(received.map(e => e.text)).toEqual(["Answer: hello"]);
    delivery = new Promise<void>(r => { resolve = r; });
    const receipt = agent.notify({ channelId: "bob", fromChannelId: "alice", text: "What is the error?" });
    expect(receipt.accepted && receipt.delivery).toBe("turn");
    if (receipt.accepted) await receipt.completion;
    await delivery;
    expect(received.map(e => e.text)).toEqual(["Answer: hello", "Answer: What is the error?"]);
    expect(new Set(received.map(e => e.turnId)).size).toBe(2);
    subscription.close(); await subscription.done;
    expect(await sendLocal(socket, { channelId: "bob", participantId: "bob", text: "after disconnect" })).toBe("Answer: after disconnect");
  } finally {
    subscription.close(); await subscription.done;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);
