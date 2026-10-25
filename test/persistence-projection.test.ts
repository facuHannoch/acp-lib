import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_AUDIT_LOG_CAPTURE, TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import {
  projectAuditEvent,
  projectTranscriptEvent,
  type NormalizedPersistenceEvent,
} from "../src/persistence/projection.ts";
import { validateAuditLogRecord, validateTranscriptRecord } from "../src/persistence/records.ts";
import { truncateSessionLogRecord } from "../src/persistence/truncation.ts";

const TS = Date.parse("2026-09-08T12:00:00.000Z");

describe("session-log capture projection", () => {
  test("tool levels are cumulative without leaking input/content into metadata", () => {
    const event: NormalizedPersistenceEvent = {
      kind: "activity",
      activity: {
        activityId: "tool-1", activityRevision: 1, operationId: "op-1",
        reason: "announced", kind: "terminal", status: "in_progress",
        metadata: { providerActivityId: "provider-tool-1", startedAt: TS },
        input: { command: "ls /home/private", path: "/home/private" },
        content: { output: "secret output" },
      },
    };
    const metadata = projectTranscriptEvent(event, transcriptContext(TRANSCRIPT_PRESETS.activity));
    expect(metadata?.t).toBe("activity");
    expect((metadata as { data: unknown }).data).toEqual({ providerActivityId: "provider-tool-1", startedAt: TS });

    const auditInput = projectAuditEvent(event, auditContext(DEFAULT_AUDIT_LOG_CAPTURE));
    expect((auditInput as { data: unknown }).data).toEqual({
      providerActivityId: "provider-tool-1", startedAt: TS,
      input: { command: "ls /home/private", path: "/home/private" },
    });
    const detailed = projectTranscriptEvent(event, transcriptContext(TRANSCRIPT_PRESETS.detailed));
    expect((detailed as { data: Record<string, unknown> }).data.content).toEqual({ output: "secret output" });
    validateTranscriptRecord(metadata);
    validateAuditLogRecord(auditInput);
    validateTranscriptRecord(detailed);
  });

  test("conversation and reasoning content never enter the audit projection implicitly", () => {
    const message: NormalizedPersistenceEvent = { kind: "message", operationId: "op-1", role: "user", text: "private prompt" };
    expect(projectTranscriptEvent(message, transcriptContext(TRANSCRIPT_PRESETS.conversation))?.t).toBe("message");
    expect(projectAuditEvent(message, auditContext({ ...DEFAULT_AUDIT_LOG_CAPTURE, reasoning: "text" }))).toBeNull();

    const reasoning: NormalizedPersistenceEvent = { kind: "reasoning", reasoningId: "think-1", reasoningRevision: 1, operationId: "op-1", text: "private reasoning", status: "completed" };
    expect(projectTranscriptEvent(reasoning, transcriptContext(TRANSCRIPT_PRESETS.activity))).toBeNull();
    expect(projectAuditEvent(reasoning, auditContext(DEFAULT_AUDIT_LOG_CAPTURE))).toBeNull();
    expect(projectAuditEvent(reasoning, auditContext({ ...DEFAULT_AUDIT_LOG_CAPTURE, reasoning: "text" }))?.t).toBe("reasoning");
  });

  test("a cancellation is written to the transcript and the audit log alike", () => {
    const event: NormalizedPersistenceEvent = {
      kind: "cancellation", operationId: "op-1", cancellationId: "op-1:cancellation",
      event: "resolved", reason: "interrupt", outcome: "acknowledged",
    };
    const transcript = projectTranscriptEvent(event, transcriptContext(TRANSCRIPT_PRESETS.conversation));
    const audit = projectAuditEvent(event, auditContext(DEFAULT_AUDIT_LOG_CAPTURE));
    validateTranscriptRecord(transcript);
    validateAuditLogRecord(audit);
    const fields = { t: "cancellation", operationId: "op-1", cancellationId: "op-1:cancellation", event: "resolved", reason: "interrupt", outcome: "acknowledged" };
    expect(transcript).toMatchObject(fields);
    expect(audit).toMatchObject(fields);
    expect(() => validateAuditLogRecord({ ...audit, reason: "other" })).toThrow("cancellation.reason is invalid");
  });

  test("presentation identity stays transcript-only", () => {
    const event: NormalizedPersistenceEvent = {
      kind: "activity",
      activity: {
        activityId: "tool-1", activityRevision: 2, operationId: "op-1",
        reason: "settled", kind: "tool", status: "completed",
        metadata: { providerActivityId: "provider-tool-1" },
      },
      presentation: { id: "activity:op-1:tool-1", position: 4, revision: 2 },
    };
    const transcript = projectTranscriptEvent(event, {
      ...transcriptContext(TRANSCRIPT_PRESETS.activity),
      seq: 5,
    });
    expect(transcript).toMatchObject({
      presentation: { id: "activity:op-1:tool-1", position: 4, revision: 2 },
    });
    validateTranscriptRecord(transcript);

    const audit = projectAuditEvent(event, auditContext(DEFAULT_AUDIT_LOG_CAPTURE));
    expect(audit).not.toHaveProperty("presentation");
    validateAuditLogRecord(audit);
  });

  test("transition continuation state remains structural while audit gets an explicit stripped descriptor", () => {
    const sessionConfiguration = {
      adapterId: "opencode", schemaDigest: null, announcedConfigIds: [], restorationTargets: [],
      effective: {}, omittedConfigIds: [], restorationFidelity: "exact" as const,
      observedAt: "2026-09-08T12:00:00.000Z",
    };
    const event: NormalizedPersistenceEvent = {
      kind: "transition", transitionId: "switch-1", transitionKind: "switch", event: "started",
      from: {
        internalSessionId: "provider-1", adapterId: "opencode", mode: "normal", model: "model",
        sessionConfiguration, activatedAt: "2026-09-08T12:00:00.000Z",
        protocol: { name: "acp", version: 1 },
      },
      summary: "must not survive metadata projection",
      reasonText: "consumer prose",
      reasonCode: "user_requested",
    };
    const transcript = projectTranscriptEvent(event, transcriptContext({ ...TRANSCRIPT_PRESETS.activity, transitions: "none" }));
    expect(transcript?.t).toBe("transition");
    expect(transcript).not.toHaveProperty("summary");
    expect((transcript as { from: { sessionConfiguration: unknown } }).from.sessionConfiguration).toEqual(sessionConfiguration);

    const audit = projectAuditEvent(event, auditContext(DEFAULT_AUDIT_LOG_CAPTURE));
    expect(audit).not.toHaveProperty("summary");
    expect(audit).not.toHaveProperty("reasonText");
    expect((audit as { from: object }).from).not.toHaveProperty("sessionConfiguration");
    expect((audit as { from: object }).from).not.toHaveProperty("activatedAt");
    validateTranscriptRecord(transcript);
    validateAuditLogRecord(audit);
  });

  test("configuration definitions and permission details require their exact levels", () => {
    const configuration: NormalizedPersistenceEvent = { kind: "configuration", event: "announced", configId: "model", value: "sonnet", definitions: { choices: ["sonnet"] }, schemaDigest: "a".repeat(64) };
    const selected = projectTranscriptEvent(configuration, transcriptContext(TRANSCRIPT_PRESETS.activity));
    expect(selected).toHaveProperty("value", "sonnet");
    expect(selected).not.toHaveProperty("definitions");
    expect(projectTranscriptEvent(configuration, transcriptContext(TRANSCRIPT_PRESETS.conversation))).toBeNull();
    expect(projectTranscriptEvent(configuration, transcriptContext(TRANSCRIPT_PRESETS.diagnostic))).toHaveProperty("definitions");

    const permission: NormalizedPersistenceEvent = { kind: "permission", permissionId: "permission-1", event: "resolved", outcome: "allowed", fullDetails: { command: "dangerous" } };
    expect(projectTranscriptEvent(permission, transcriptContext(TRANSCRIPT_PRESETS.activity))).not.toHaveProperty("details");
    expect(projectTranscriptEvent(permission, transcriptContext(TRANSCRIPT_PRESETS.detailed))).toHaveProperty("details");
  });

  test("normalized protocol metadata is sorted while raw traffic is diagnostic-only", () => {
    const metadata: NormalizedPersistenceEvent = { kind: "protocol_metadata", event: "initialized", protocol: { name: "acp", version: 1 }, capabilities: { "z.last": true, "a.first": false } };
    const projected = projectTranscriptEvent(metadata, transcriptContext(TRANSCRIPT_PRESETS.diagnostic));
    expect(Object.keys((projected as { capabilities: object }).capabilities)).toEqual(["a.first", "z.last"]);
    validateTranscriptRecord(projected);

    const raw: NormalizedPersistenceEvent = { kind: "raw_protocol", protocol: "acp", direction: "agent_to_client", event: "session/update", data: { secret: "yes" } };
    expect(projectTranscriptEvent(raw, transcriptContext(TRANSCRIPT_PRESETS.detailed))).toBeNull();
    expect(projectTranscriptEvent(raw, transcriptContext(TRANSCRIPT_PRESETS.diagnostic))?.t).toBe("raw");
    expect(projectAuditEvent(raw, auditContext(DEFAULT_AUDIT_LOG_CAPTURE))).toBeNull();
  });

  test("capture filtering runs before truncation and optional digesting", () => {
    const secret = "consumer-secret-".repeat(500);
    const event: NormalizedPersistenceEvent = {
      kind: "activity",
      activity: {
        activityId: "tool-1", activityRevision: 1, operationId: "op-1",
        reason: "announced", kind: "terminal", status: "in_progress",
        metadata: { providerActivityId: "provider-tool-1", startedAt: TS },
        input: { command: secret },
        content: { output: secret },
      },
    };
    const projected = projectTranscriptEvent(event, transcriptContext(TRANSCRIPT_PRESETS.activity));
    if (!projected) throw new Error("activity projection unexpectedly omitted");
    const bounded = truncateSessionLogRecord(projected, {
      limits: { maxRecordBytes: 4_096, maxCapturedFieldBytes: 1_024, maxJsonDepth: 8, maxCursorBytes: 4_096 },
      includeTruncationDigests: true,
    });
    const serialized = JSON.stringify(bounded);
    const digest = createHash("sha256").update(Buffer.from(JSON.stringify({ command: secret }), "utf8")).digest("hex");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(digest);
    expect(bounded.truncation).toBeUndefined();
  });
});

function transcriptContext(policy: typeof TRANSCRIPT_PRESETS.activity) {
  return { transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1", seq: 2, ts: TS, policy };
}
function auditContext(policy: typeof DEFAULT_AUDIT_LOG_CAPTURE) {
  return { auditLogId: "audit-1", generation: 1, agentSessionId: "agent-1", seq: 2, ts: TS, policy };
}
