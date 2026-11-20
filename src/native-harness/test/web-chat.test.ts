import { expect, test } from "bun:test";
import { serveWebChat } from "../src/interfaces/web-chat/server.ts";
import { createChannelHandler } from "../src/interfaces/protocol/local.ts";
import { createChannelOutputs, publishChannelEvent } from "../src/interfaces/protocol/output.ts";
import { createSession } from "../src/index.ts";
import { lastInput } from "./helpers/session.ts";

test("LAN chat uses the same agent, requires pairing and delivers notice-started output", async () => {
  const outputs = createChannelOutputs();
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({
    model: async messages => ({ role: "assistant", content: lastInput(messages), calls: [] }),
    tools: [], executeTool: async () => "unused",
  }) });
  session.subscribe(event => publishChannelEvent(outputs, event));
  session.start();
  const agent = session.agent;
  const chat = serveWebChat(createChannelHandler(session, outputs), 0, "test-pairing");
  const base = `http://127.0.0.1:${chat.server.port}`;
  let reader: { cancel(): Promise<void> } | undefined;
  try {
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(`${base}/events?channelId=bob`)).status).toBe(401);
    expect((await fetch(`${base}/state?token=test-pairing`)).status).toBe(404);
    expect((await fetch(`${base}/messages`, { method: "POST", headers: { Authorization: "Bearer test-pairing", Origin: "http://elsewhere" }, body: "{}" })).status).toBe(403);
    const events = await fetch(`${base}/events?channelId=bob&token=test-pairing`);
    const stream = events.body!.getReader(); reader = stream;
    expect(new TextDecoder().decode((await stream.read()).value)).toContain("event: ready");
    const response = await fetch(`${base}/messages`, { method: "POST", headers: { Authorization: "Bearer test-pairing", Origin: base },
      body: JSON.stringify({channelId:"bob",participantId:"bob",text:"hello"}) });
    expect(await response.json()).toEqual({ answer: "hello" });
    expect(new TextDecoder().decode((await stream.read()).value)).toContain('"text":"hello"');
    expect(agent.notify({ channelId: "bob", fromChannelId: "alice", text: "Alice says hi" }).accepted).toBe(true);
    expect(new TextDecoder().decode((await stream.read()).value)).toContain("Alice says hi");
  } finally { await reader?.cancel(); await chat.server.stop(true); }
});
