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

  test("carries tool_call content, locations and raw io", () => {
    expect(
      toActivityEvent({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
        rawOutput: { code: 0 },
        content: [
          { type: "content", content: { type: "text", text: "a.txt" } },
          { type: "diff", path: "/a", oldText: null, newText: "x" },
          { type: "terminal", terminalId: "term-1" },
          { type: "something_new", extra: 1 },
        ],
        locations: [{ path: "/a", line: 2 }, { path: "/b" }],
      } as never),
    ).toEqual({
      kind: "tool",
      toolCallId: "tool-1",
      title: "Terminal",
      toolKind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
      rawOutput: { code: 0 },
      content: [
        { type: "content", content: { type: "text", text: "a.txt" }, text: "a.txt" },
        { type: "diff", path: "/a", oldText: null, newText: "x" },
        { type: "terminal", terminalId: "term-1" },
        { type: "other", raw: { type: "something_new", extra: 1 } },
      ],
      locations: [{ path: "/a", line: 2 }, { path: "/b" }],
    });
  });

  test("tool_call_update keeps everything the agent changed", () => {
    expect(
      toActivityEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran ls",
        kind: "execute",
        rawInput: { command: "ls" },
        rawOutput: { stdout: "a.txt" },
        content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
      } as never),
    ).toEqual({
      kind: "tool_update",
      toolCallId: "tool-1",
      status: "completed",
      title: "Ran ls",
      toolKind: "execute",
      rawInput: { command: "ls" },
      rawOutput: { stdout: "a.txt" },
      content: [{ type: "content", content: { type: "text", text: "a.txt" }, text: "a.txt" }],
    });
  });

  test("tool_call_update leaves unchanged fields absent", () => {
    // The wire spells "unchanged" as absent OR null; inventing a value here would make
    // a caller overwrite a good title/status with a placeholder.
    const event = toActivityEvent({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: null,
      status: null,
      content: null,
    } as never);

    expect(event).toEqual({ kind: "tool_update", toolCallId: "tool-1" });
    expect(Object.keys(event!).sort()).toEqual(["kind", "toolCallId"]);
  });

  test("maps the rest of the update union", () => {
    expect(
      toActivityEvent({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
      } as never),
    ).toEqual({ kind: "user_message", text: "hi" });

    expect(toActivityEvent({ sessionUpdate: "current_mode_update", currentModeId: "plan" } as never))
      .toEqual({ kind: "mode", modeId: "plan" });

    expect(toActivityEvent({ sessionUpdate: "usage_update", used: 10, size: 100 } as never))
      .toEqual({ kind: "usage", used: 10, size: 100 });

    expect(
      toActivityEvent({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "model" }],
      } as never),
    ).toEqual({ kind: "commands", commands: [{ name: "model", description: "" }] });

    expect(toActivityEvent({ sessionUpdate: "plan_removed", id: "plan-1" } as never))
      .toEqual({ kind: "plan_removed", planId: "plan-1" });
  });

  test("surfaces unmodelled updates instead of dropping them", () => {
    const update = { sessionUpdate: "some_future_update", payload: { a: 1 } };
    expect(toActivityEvent(update as never)).toEqual({
      kind: "unknown",
      sessionUpdate: "some_future_update",
      raw: update,
    });
  });

  test("agent_message_chunk is response text, not activity", () => {
    expect(
      toActivityEvent({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      } as never),
    ).toBeNull();
  });
});
