import { describe, expect, test } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/client.ts";
import type { ResponseChunk } from "../src/types.ts";

interface WireChunk {
  text: string;
  messageId?: string;
}

function clientWithResponse(chunks: WireChunk[]): AcpClient {
  const client = new AcpClient({ adapter: { command: ["unused"] } });
  const internals = client as unknown as {
    transport: {
      prompt(request: schema.PromptRequest): Promise<schema.PromptResponse>;
    };
    _sessionId: string;
    handleUpdate(notification: schema.SessionNotification): void;
  };

  internals._sessionId = "session-1";
  internals.transport = {
    async prompt() {
      for (const chunk of chunks) {
        internals.handleUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk.text },
            ...(chunk.messageId === undefined ? {} : { messageId: chunk.messageId }),
          },
        } as schema.SessionNotification);
      }
      return { stopReason: "end_turn" } as schema.PromptResponse;
    },
  };
  return client;
}

describe("AcpClient response boundaries", () => {
  test("coalesces token continuations and separates changed message ids", async () => {
    const client = clientWithResponse([
      { messageId: "m1", text: "I'm checking " },
      { messageId: "m1", text: "now." },
      { messageId: "m2", text: "I've finished." },
      { messageId: "m3", text: "I'm running tests." },
    ]);
    const legacy: string[] = [];
    const streamed: ResponseChunk[] = [];

    const result = await client.prompt("go", {
      onChunk: (text) => legacy.push(text),
      onResponseChunk: (chunk) => streamed.push(chunk),
    });

    expect(legacy).toEqual([
      "I'm checking ",
      "now.",
      "I've finished.",
      "I'm running tests.",
    ]);
    expect(streamed.map(({ messageId, startsMessage }) => ({ messageId, startsMessage })))
      .toEqual([
        { messageId: "m1", startsMessage: true },
        { messageId: "m1", startsMessage: false },
        { messageId: "m2", startsMessage: true },
        { messageId: "m3", startsMessage: true },
      ]);
    expect(result.messages).toEqual([
      { messageId: "m1", text: "I'm checking now." },
      { messageId: "m2", text: "I've finished." },
      { messageId: "m3", text: "I'm running tests." },
    ]);
    expect(result.text).toBe("I'm checking now.I've finished.I'm running tests.");
  });

  test("does not invent boundaries for chunks with missing ids", async () => {
    const client = clientWithResponse([
      { text: "before " },
      { messageId: "m1", text: "identified " },
      { text: "continuation" },
      { messageId: "m2", text: "new" },
    ]);

    const result = await client.prompt("go");

    expect(result.messages).toEqual([
      { messageId: "m1", text: "before identified continuation" },
      { messageId: "m2", text: "new" },
    ]);
  });
});
