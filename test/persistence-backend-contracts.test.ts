import { describe, expect, test } from "bun:test";
import type { AgentConversationId, AgentSessionId } from "../src/agent-ids.ts";
import {
  DEFAULT_CONVERSATION_RECORD_CAPTURE,
  IMPLICIT_USER_PARTICIPANT_ID,
  isConversationRecordKind,
  normalizeParticipantRef,
  resolveConversationRecordCapture,
  searchableText,
  shouldCaptureProtocolMethod,
  type MessageRecord,
  type ToolCallRecord,
} from "../src/persistence/index.ts";

const agentSessionId = "ags-00000000-0000-4000-8000-000000000000" as AgentSessionId;
const agentConversationId = "agc-00000000-0000-4000-8000-000000000000" as AgentConversationId;

describe("persistence backend contracts", () => {
  test("participant continuity ignores display-name changes", () => {
    expect(normalizeParticipantRef({ id: " bob ", kind: "agent", name: " Bob " })).toEqual({
      id: "bob",
      kind: "agent",
      name: "Bob",
    });
    expect(normalizeParticipantRef({ id: "bob", kind: "agent", name: "" })).toEqual({
      id: "bob",
      kind: "agent",
    });
    expect(IMPLICIT_USER_PARTICIPANT_ID).toBe("user:default");
  });

  test("participant validation rejects blank ids and unsupported kinds", () => {
    expect(() => normalizeParticipantRef({ id: " ", kind: "user" })).toThrow("cannot be blank");
    expect(() => normalizeParticipantRef({ id: "x", kind: "service" as "user" })).toThrow(
      "unsupported participant kind",
    );
  });

  test("capture overrides are immutable, complete, and reject unknown input", () => {
    const resolved = resolveConversationRecordCapture({
      thinking: "content",
      protocol: { level: "metadata", excludeMethods: ["session/update"] },
    });
    expect(resolved).toEqual({
      ...DEFAULT_CONVERSATION_RECORD_CAPTURE,
      thinking: "content",
      protocol: {
        level: "metadata",
        includeMethods: [],
        excludeMethods: ["session/update"],
      },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.protocol.excludeMethods)).toBe(true);
    expect(() => resolveConversationRecordCapture({ message: "invalid" as "none" })).toThrow(
      "invalid capture level",
    );
    expect(() => resolveConversationRecordCapture({ future: "content" } as never)).toThrow(
      "unknown record capture kind",
    );
    expect(() => resolveConversationRecordCapture({ protocol: "content" as "raw" })).toThrow(
      "invalid capture level for protocol",
    );
    expect(() => resolveConversationRecordCapture({
      protocol: { level: "metadata", includeMethods: ["initialize"], excludeMethods: ["session/update"] },
    })).toThrow("cannot combine includeMethods and excludeMethods");

    const included = resolveConversationRecordCapture({
      protocol: { level: "metadata", includeMethods: ["initialize"] },
    }).protocol;
    expect(shouldCaptureProtocolMethod(included, "initialize")).toBe(true);
    expect(shouldCaptureProtocolMethod(included, "session/update")).toBe(false);
    expect(shouldCaptureProtocolMethod(included, undefined)).toBe(true);
  });

  test("record-kind detection is strict", () => {
    expect(isConversationRecordKind("message")).toBe(true);
    expect(isConversationRecordKind("marker")).toBe(false);
    expect(isConversationRecordKind(1)).toBe(false);
  });

  test("search projections preserve message boundaries", () => {
    const first: MessageRecord = {
      recordId: "r1",
      agentSessionId,
      agentConversationId,
      sequence: 1,
      kind: "message",
      timestamp: "2026-09-17T00:00:00.000Z",
      role: "assistant",
      content: [{ type: "text", text: "first message" }],
    };
    const second: MessageRecord = {
      ...first,
      recordId: "r2",
      sequence: 2,
      content: "second message",
    };
    expect(searchableText(first)).toBe("first message");
    expect(searchableText(second)).toBe("second message");
  });

  test("tool search includes name, input, and captured output", () => {
    const record: ToolCallRecord = {
      recordId: "tool-record",
      agentSessionId,
      agentConversationId,
      sequence: 3,
      kind: "tool_call",
      timestamp: "2026-09-17T00:00:00.000Z",
      toolCallId: "call-1",
      state: "completed",
      name: "terminal.exec",
      input: { command: "bun test" },
      output: "700 tests passed",
    };
    expect(searchableText(record)).toContain("terminal.exec");
    expect(searchableText(record)).toContain("bun test");
    expect(searchableText(record)).toContain("700 tests passed");
  });
});
