import { describe, expect, test } from "bun:test";
import type { AggregatedRecord } from "../src/activity.ts";
import { persistenceEventFromActivity } from "../src/persistence/activity-projection.ts";
import { TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import { projectTranscriptEvent } from "../src/persistence/projection.ts";

describe("folded activity persistence classification", () => {
  test("keeps tool identity in metadata while input and results remain separate buckets", () => {
    const event = persistenceEventFromActivity(tool(), "op-1");
    const activity = event.kind === "activity" ? event.activity : null;
    expect(activity?.metadata).toEqual({ providerActivityId: "call-1" });
    expect(activity?.metadata).not.toHaveProperty("title");
    expect(activity?.input).toEqual({ value: { command: "ls /private" } });
    expect(activity?.content).toMatchObject({ title: "List /private", rawOutput: "secret" });

    const metadata = projectTranscriptEvent(event, context(TRANSCRIPT_PRESETS.activity));
    expect(metadata).toHaveProperty("data", { providerActivityId: "call-1" });
    expect(JSON.stringify(metadata)).not.toContain("/private");
    expect(JSON.stringify(metadata)).not.toContain("secret");
  });

  test("maps folded thinking to revisioned reasoning with its terminal state", () => {
    const event = persistenceEventFromActivity({
      recordId: "think-1", seq: 4, reason: "flushed",
      event: { kind: "thinking", text: "private thought" },
    }, "op-1");
    expect(event).toEqual({
      kind: "reasoning", reasoningId: "think-1", reasoningRevision: 4,
      operationId: "op-1", text: "private thought", status: "completed",
    });
    expect(projectTranscriptEvent(event, context(TRANSCRIPT_PRESETS.activity))).toBeNull();
    expect(projectTranscriptEvent(event, context(TRANSCRIPT_PRESETS.detailed))).toHaveProperty("text", "private thought");
  });

  test("puts non-tool activity payloads in content rather than metadata", () => {
    const event = persistenceEventFromActivity({
      recordId: "plan", seq: 2, reason: "snapshot",
      event: { kind: "plan", entries: [{ content: "secret plan", priority: "high", status: "pending" }] },
    }, "op-1");
    const metadata = projectTranscriptEvent(event, context(TRANSCRIPT_PRESETS.activity));
    expect(metadata).toHaveProperty("data", {});
    expect(JSON.stringify(metadata)).not.toContain("secret plan");
    expect(JSON.stringify(projectTranscriptEvent(event, context(TRANSCRIPT_PRESETS.detailed)))).toContain("secret plan");
  });

  test("does not turn session state or unknown protocol updates into model activity", () => {
    for (const event of [
      { kind: "usage" as const, used: 12, size: 100 },
      { kind: "commands" as const, commands: [] },
      { kind: "mode" as const, modeId: "code" },
      { kind: "session_info" as const, title: "New title" },
      { kind: "config" as const, configOptions: [] },
      { kind: "unknown" as const, sessionUpdate: "future_update", raw: { value: 1 } },
    ]) {
      expect(persistenceEventFromActivity({
        recordId: `state-${event.kind}`,
        seq: 5,
        reason: "snapshot",
        event,
      }, "op-1")).toBeNull();
    }
  });
});

function tool(): AggregatedRecord {
  return {
    recordId: "call-1", seq: 3, reason: "settled",
    event: {
      kind: "tool", toolCallId: "call-1", title: "List /private", toolKind: "terminal",
      status: "completed", rawInput: { command: "ls /private" }, rawOutput: "secret",
      content: [{ type: "content", content: { type: "text", text: "secret" }, text: "secret" }],
    },
  };
}

function context(policy: typeof TRANSCRIPT_PRESETS.activity) {
  return { transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1", seq: 2, ts: 1, policy };
}
