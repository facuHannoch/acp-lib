import { describe, expect, test } from "bun:test";
import { truncateSessionLogRecord, SessionLogTruncationError } from "../src/persistence/truncation.ts";
import { validateTranscriptRecord, type TranscriptActivityRecord, type TranscriptMessageRecord, type TranscriptOperationRecord } from "../src/persistence/records.ts";

const TS = Date.parse("2026-09-08T12:00:00.000Z");
const LIMITS = { maxRecordBytes: 4_096, maxCapturedFieldBytes: 1_024, maxJsonDepth: 8, maxCursorBytes: 4_096 };

describe("session-log truncation", () => {
  test("truncates message text on a Unicode code-point boundary and keeps the record", () => {
    const original = "🦊".repeat(400);
    const record = message(original);
    const output = truncateSessionLogRecord(record, { limits: LIMITS });
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(output.text.endsWith("�")).toBe(false);
    expect(output.truncation).toEqual([{ field: "text", reason: "field_limit", originalBytes: 1_600 }]);
    expect(record.text).toBe(original);
    validateTranscriptRecord(output);
  });

  test("replaces structured tool output as a whole and optionally engraves its digest", () => {
    const record: TranscriptActivityRecord = {
      ...envelope(), t: "activity", operationId: "op-1", activityId: "tool-1",
      activityRevision: 1, reason: "settled", kind: "terminal", status: "completed",
      data: { providerActivityId: "tool-1", content: { output: "secret".repeat(500) } },
    };
    const output = truncateSessionLogRecord(record, { limits: LIMITS, includeTruncationDigests: true });
    expect(output.data.content).toMatchObject({ omitted: true, reason: "field_limit" });
    expect(output.truncation?.[0]?.originalSha256).toMatch(/^[0-9a-f]{64}$/);
    validateTranscriptRecord(output);
  });

  test("record limit can shorten a field below its otherwise allowed field limit", () => {
    const limits = { ...LIMITS, maxCapturedFieldBytes: 4_096 };
    const output = truncateSessionLogRecord(message("x".repeat(4_000)), { limits });
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(4_096);
    expect(output.text.length).toBeLessThan(4_000);
    expect(output.truncation?.find((item) => item.field === "text")?.reason).toBe("record_limit");
  });

  test("deep captured detail becomes an explicit omitted value", () => {
    let detail: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) detail = { nested: detail };
    const output = truncateSessionLogRecord({ ...envelope(), t: "lifecycle", event: "session_opened", detail } as never, { limits: LIMITS });
    expect(output.detail).toEqual({ omitted: true, reason: "max_depth" });
    validateTranscriptRecord(output);
  });

  test("rejects non-JSON captured values instead of misreporting them as depth truncation", () => {
    const record = {
      ...envelope(), t: "lifecycle", event: "session_opened", detail: { invalid: undefined },
    } as never;
    expect(() => truncateSessionLogRecord(record, { limits: LIMITS })).toThrow(SessionLogTruncationError);
  });

  test("never truncates structural operation identity to force a record under the limit", () => {
    const record: TranscriptOperationRecord = {
      ...envelope(), t: "operation", operationId: "x".repeat(5_000), event: "settled", operationKind: "prompt",
    };
    expect(() => truncateSessionLogRecord(record, { limits: LIMITS })).toThrow(SessionLogTruncationError);
  });
});

function envelope() {
  return { v: 2 as const, transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1", seq: 2, ts: TS };
}
function message(text: string): TranscriptMessageRecord {
  return { ...envelope(), t: "message", operationId: "op-1", role: "assistant", text };
}
