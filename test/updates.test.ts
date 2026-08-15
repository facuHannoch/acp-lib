import { describe, expect, test } from "bun:test";
import { extractChunkText, toActivityEvent, toAgentCommands } from "../src/updates.ts";
import type { ToolActivity, ToolUpdateActivity } from "../src/types.ts";

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

  test("the documented merge preserves fields an update omits", () => {
    // The README tells callers to merge with a spread. That is only safe if absent
    // fields are ABSENT KEYS — a present `undefined` would clobber the good value.
    const call = toActivityEvent({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls" },
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    } as never) as ToolActivity;

    // A bare update, and one that spells "unchanged" as an explicit null.
    for (const update of [
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        title: null,
        kind: null,
        rawInput: null,
        content: null,
        locations: null,
      },
    ]) {
      const delta = toActivityEvent(update as never) as ToolUpdateActivity;
      const merged = { ...call, ...delta, kind: "tool" as const };

      expect(merged.status).toBe("completed");
      expect(merged.title).toBe("Bash");
      expect(merged.toolKind).toBe("execute");
      expect(merged.rawInput).toEqual({ command: "ls" });
      expect(merged.content).toEqual(call.content);
    }
  });

  test("content REPLACES rather than accumulates", () => {
    // The schema is explicit for ToolCallUpdate.content: "Replace the content
    // collection." So a caller must overwrite, never concatenate — agents that stream a
    // growing tool input resend the whole thing each time (Kimi: `{"command":"` →
    // `{"command":"ls"}`). Concatenating would produce garbage; this pins the contract.
    const first = toActivityEvent({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      content: [{ type: "content", content: { type: "text", text: '{"command":"' } }],
    } as never) as ToolUpdateActivity;

    const second = toActivityEvent({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      content: [{ type: "content", content: { type: "text", text: '{"command":"ls"}' } }],
    } as never) as ToolUpdateActivity;

    expect(second.content).toHaveLength(1);
    expect(second.content?.[0]).toMatchObject({ text: '{"command":"ls"}' });

    // Merging the second over the first yields the second's content verbatim — no
    // trace of the earlier fragment.
    const merged = { ...first, ...second };
    expect(merged.content).toEqual(second.content);
    expect(merged.content).not.toEqual(first.content);
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

  test("normalizes command metadata into immutable, deduplicated snapshots", () => {
    const commands = toAgentCommands([
      {
        name: " usage ",
        description: "Show usage",
        input: { hint: "optional scope" },
      },
      { name: "usage", description: "duplicate is ignored" },
      { name: "status" },
      { name: "   " },
      { description: "missing name" },
      null,
    ]);

    expect(commands).toEqual([
      {
        name: "usage",
        description: "Show usage",
        input: { kind: "unstructured", hint: "optional scope" },
      },
      { name: "status", description: "" },
    ]);
    expect(Object.isFrozen(commands)).toBe(true);
    expect(commands.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(commands[0]!.input!)).toBe(true);
  });

  test("omits malformed command input metadata", () => {
    expect(toAgentCommands([
      { name: "one", input: { hint: 42 } },
      { name: "two", input: "not an input object" },
    ])).toEqual([
      { name: "one", description: "" },
      { name: "two", description: "" },
    ]);
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
