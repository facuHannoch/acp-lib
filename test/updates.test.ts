import { describe, expect, test } from "bun:test";
import { extractChunkText, toActivityEvent } from "../src/updates.ts";

describe("session updates", () => {
  test("extracts only agent text chunks", () => {
    expect(
      extractChunkText({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      } as never),
    ).toBe("hello");
    expect(
      extractChunkText({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      } as never),
    ).toBe("");
  });

  test("maps tool and plan activity", () => {
    expect(
      toActivityEvent({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        kind: "read",
        status: "pending",
      } as never),
    ).toEqual({
      kind: "tool",
      toolCallId: "tool-1",
      title: "Read file",
      toolKind: "read",
      status: "pending",
      rawInput: undefined,
    });
    expect(
      toActivityEvent({
        sessionUpdate: "plan",
        entries: [{ content: "Inspect", priority: "high", status: "pending" }],
      } as never),
    ).toEqual({
      kind: "plan",
      entries: [{ content: "Inspect", priority: "high", status: "pending" }],
    });
  });
});
