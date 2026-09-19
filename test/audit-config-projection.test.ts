import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_AUDIT_CAPTURE,
  projectAgentAuditObservation,
  resolveAgentAuditCapture,
  resolveAgentAuditLogConfig,
  type NormalizedConversationObservation,
} from "../src/audit/index.ts";
import { createAgentConversationId, createAgentSessionId } from "../src/agent-ids.ts";

const agentSessionId = createAgentSessionId();
const agentConversationId = createAgentConversationId();

describe("agent audit configuration", () => {
  test("resolves conservative defaults and a stable capture fingerprint", () => {
    const first = resolveAgentAuditLogConfig({ directory: "logs" }, "/workspace");
    const second = resolveAgentAuditLogConfig({ directory: "logs" }, "/workspace");
    expect(first.directory).toBe("/workspace/logs");
    expect(first.filePrefix).toBe("audit");
    expect(first.capture).toEqual(DEFAULT_AGENT_AUDIT_CAPTURE);
    expect(first.captureFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.captureFingerprint).toBe(second.captureFingerprint);
  });

  test("rejects unsafe destinations and nonsensical timing or rotation", () => {
    expect(() => resolveAgentAuditLogConfig({ directory: " " })).toThrow("directory cannot be blank");
    expect(() => resolveAgentAuditLogConfig({ directory: "logs", filePrefix: "../audit" })).toThrow(
      "safe filename component",
    );
    expect(() => resolveAgentAuditLogConfig({
      directory: "logs",
      rotation: { maxBytes: false, maxAgeMs: false },
    })).toThrow("at least one enabled trigger");
    expect(() => resolveAgentAuditLogConfig({
      directory: "logs",
      retry: { initialDelayMs: 10, maxDelayMs: 9 },
    })).toThrow("maxDelayMs");
  });

  test("rejects unknown kinds and invalid specialized levels", () => {
    expect(() => resolveAgentAuditCapture({ unknown: "raw" } as never)).toThrow("unknown audit capture kind");
    expect(() => resolveAgentAuditCapture({ tool_call: "decision" } as never)).toThrow(
      "invalid audit capture level for tool_call",
    );
  });
});

describe("agent audit projection", () => {
  test("is independent from canonical message capture", () => {
    const full = messageObservation("private body");
    expect(projectAgentAuditObservation(full, DEFAULT_AGENT_AUDIT_CAPTURE)).toBeNull();
    const projected = projectAgentAuditObservation(full, resolveAgentAuditCapture({ message: "content" }));
    expect(projected?.payload).toMatchObject({ role: "user", content: "private body" });
    expect(full.record).toMatchObject({ content: "private body" });
  });

  test("tool input and content levels expose distinct fields", () => {
    const observation: NormalizedConversationObservation = {
      scope: "conversation",
      sourceObservationId: "tool-record",
      record: {
        recordId: "tool-record",
        agentSessionId,
        agentConversationId,
        kind: "tool_call",
        timestamp: "2026-09-19T00:00:00.000Z",
        toolCallId: "call-1",
        state: "completed",
        name: "read",
        input: { path: "/tmp/example" },
        output: "contents",
      },
    };
    const input = projectAgentAuditObservation(observation, resolveAgentAuditCapture({ tool_call: "input" }));
    expect(input?.payload).toMatchObject({ input: { path: "/tmp/example" } });
    expect(input?.payload).not.toHaveProperty("output");
    const content = projectAgentAuditObservation(observation, resolveAgentAuditCapture({ tool_call: "content" }));
    expect(content?.payload).toMatchObject({ input: { path: "/tmp/example" }, output: "contents" });
  });

  test("protocol method filters run before projection", () => {
    const observation: NormalizedConversationObservation = {
      scope: "conversation",
      sourceObservationId: "protocol-record",
      record: {
        recordId: "protocol-record",
        agentSessionId,
        agentConversationId,
        kind: "protocol",
        timestamp: "2026-09-19T00:00:00.000Z",
        direction: "in",
        method: "session/update",
        message: { secret: true },
      },
    };
    const filtered = resolveAgentAuditCapture({
      protocol: { level: "raw", excludeMethods: ["session/update"] },
    });
    expect(projectAgentAuditObservation(observation, filtered)).toBeNull();
    const metadata = projectAgentAuditObservation(observation, resolveAgentAuditCapture({ protocol: "metadata" }));
    expect(metadata?.payload).not.toHaveProperty("message");
  });

  test("bounds an oversized captured payload before it reaches the outbox", () => {
    const projected = projectAgentAuditObservation(
      messageObservation("x".repeat(300_000)),
      resolveAgentAuditCapture({ message: "content" }),
    );
    expect(projected?.payload).toEqual({
      omitted: true,
      reason: "field_limit",
      originalBytes: expect.any(Number),
    });
  });
});

function messageObservation(content: string): NormalizedConversationObservation {
  return {
    scope: "conversation",
    sourceObservationId: "message-record",
    record: {
      recordId: "message-record",
      agentSessionId,
      agentConversationId,
      kind: "message",
      timestamp: "2026-09-19T00:00:00.000Z",
      role: "user",
      content,
      status: "completed",
    },
  };
}
