import { describe, expect, test } from "bun:test";
import { createAgentSessionCheckpoint, type AgentSessionCheckpointInput } from "../src/persistence/checkpoint.ts";
import { DEFAULT_PERSISTENCE_LIMITS, TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import { sha256CanonicalJson } from "../src/persistence/integrity.ts";
import {
  SessionLogRecordValidationError,
  validateAuditLogRecord,
  validateTranscriptRecord,
} from "../src/persistence/records.ts";

const NOW = "2026-09-08T12:00:00.000Z";
const TS = Date.parse(NOW);
const DIGEST = "a".repeat(64);

describe("session-log record schemas", () => {
  test("accepts a transcript operation boundary with exact abort semantics", () => {
    const started = transcript({
      t: "operation",
      operationId: "op-1",
      stateRevision: 2,
      event: "started",
      operationKind: "prompt",
    });
    expect(() => validateTranscriptRecord(started, expectation())).not.toThrow();

    expectInvalidTranscript({
      ...started,
      event: "aborted",
    }, "operation.abortReason is invalid");
    expectInvalidTranscript({
      ...started,
      event: "settled",
      abortReason: "pre_dispatch_cancelled",
    }, "allowed only for aborted");
    expectInvalidTranscript({
      ...started,
      event: "aborted",
      abortReason: "pre_dispatch_cancelled",
      errorCode: "provider_failed",
    }, "cannot contain errorCode");
  });

  test("validates checkpoint envelope and payload identities", () => {
    const checkpoint = createAgentSessionCheckpoint(checkpointInput());
    const record = transcript({
      t: "checkpoint",
      seq: 3,
      stateRevision: 1,
      checkpoint,
    });
    expect(() => validateTranscriptRecord(record, {
      ...expectation(),
      transcriptPath: "/data/transcripts/agent-1.jsonl",
    })).not.toThrow();
    expectInvalidTranscript({ ...record, stateRevision: 2 }, "stateRevision mismatch");
    expectInvalidTranscript({
      ...record,
      checkpoint: createAgentSessionCheckpoint(checkpointInput({
        transcript: { ...checkpointInput().transcript!, coveredSequence: 3 },
      })),
    }, "coveredSequence must precede");
  });

  test("requires installation provenance on new headers and not legacy upgrades", () => {
    const base = transcript({
      t: "header",
      event: "created",
      createdAt: NOW,
      preset: "activity",
      effectivePolicy: TRANSCRIPT_PRESETS.activity,
      effectiveLimits: DEFAULT_PERSISTENCE_LIMITS,
      includeTruncationDigests: false,
      installation: {
        kind: "creation",
        operationId: "create-1",
        requestDigest: DIGEST,
      },
    });
    expect(() => validateTranscriptRecord(base)).not.toThrow();
    const { installation: _installation, ...withoutInstallation } = base;
    expectInvalidTranscript(withoutInstallation, "installation must be an object");

    const upgraded = { ...base, event: "upgraded", upgradedFrom: { version: 1, boundaryOffset: 12 } };
    expectInvalidTranscript(upgraded, "must not contain installation");
    const { installation: _upgradeInstallation, ...upgradeWithoutInstallation } = upgraded;
    expect(() => validateTranscriptRecord(upgradeWithoutInstallation)).not.toThrow();
  });

  test("keeps audit transition content on an explicit allowlist", () => {
    const audit = auditRecord({
      t: "transition",
      transitionId: "switch-1",
      kind: "switch",
      event: "started",
      from: null,
      reasonCode: "user_requested",
    });
    expect(() => validateAuditLogRecord(audit)).not.toThrow();
    expectInvalidAudit({ ...audit, reasonText: "contains a path or secret" }, "invalid audit transition content");
    expectInvalidAudit({
      ...audit,
      from: {
        internalSessionId: "provider-1",
        adapterId: "opencode",
        mode: "normal",
        model: "model",
        protocol: { name: "acp", version: 1 },
        sessionConfiguration: { secret: true },
      },
    }, "sessionConfiguration is invalid audit transition content");
  });

  test("does not require transcript continuation state on audit operation boundaries", () => {
    expect(() => validateAuditLogRecord(auditRecord({
      t: "operation",
      event: "started",
      operationId: "op-1",
      operationKind: "prompt",
    }))).not.toThrow();
  });

  test("rejects unsafe machine codes, malformed truncation, and identity disagreement", () => {
    const record = transcript({
      t: "operation",
      operationId: "op-1",
      event: "failed",
      operationKind: "prompt",
      errorCode: "contains spaces",
      truncation: [{ field: "data.output", reason: "field_limit", originalBytes: 10 }],
    });
    expectInvalidTranscript(record, "errorCode is invalid");
    expectInvalidTranscript({
      ...record,
      errorCode: "provider_failed",
      truncation: [{ field: "data.output", reason: "field_limit", originalBytes: -1 }],
    }, "nonnegative safe integer");
    expectInvalidTranscript({ ...record, errorCode: "provider_failed" }, "agentSessionId mismatch", {
      agentSessionId: "another-agent",
    });
  });

  test("rejects transcript-only record kinds in an audit log", () => {
    expectInvalidAudit(auditRecord({ t: "message", role: "user", text: "secret" }), "unknown audit-log record type");
    expectInvalidAudit(auditRecord({ t: "raw", protocol: "acp", direction: "agent_to_client", event: "update", data: {} }), "unknown audit-log record type");
  });
});

function transcript(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 2,
    transcriptId: "transcript-1",
    generation: 1,
    agentSessionId: "agent-1",
    seq: 2,
    ts: TS,
    ...fields,
  };
}

function auditRecord(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    auditLogId: "audit-1",
    generation: 1,
    agentSessionId: "agent-1",
    seq: 1,
    ts: TS,
    ...fields,
  };
}

function expectation() {
  return { agentSessionId: "agent-1", logId: "transcript-1", generation: 1 };
}

function checkpointInput(overrides: Partial<AgentSessionCheckpointInput> = {}): AgentSessionCheckpointInput {
  return {
    agentSessionId: "agent-1",
    incarnationId: "creation-1",
    stateRevision: 1,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: "provider-1",
    internalSessionActivatedAt: NOW,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: sha256CanonicalJson([]),
    model: "anthropic/claude-sonnet-4-5",
    sessionConfiguration: {
      adapterId: "opencode",
      schemaDigest: null,
      announcedConfigIds: [],
      restorationTargets: [],
      effective: {},
      omittedConfigIds: [],
      restorationFidelity: "exact",
      observedAt: NOW,
    },
    protocol: { name: "acp", version: 1 },
    transcript: {
      transcriptId: "transcript-1",
      generation: 1,
      path: "/data/transcripts/agent-1.jsonl",
      coveredSequence: 1,
    },
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: NOW,
    ...overrides,
  };
}

function expectInvalidTranscript(
  value: unknown,
  message: string,
  expected = expectation(),
): void {
  expect(() => validateTranscriptRecord(value, expected)).toThrow(message);
  expect(() => validateTranscriptRecord(value, expected)).toThrow(SessionLogRecordValidationError);
}

function expectInvalidAudit(value: unknown, message: string): void {
  expect(() => validateAuditLogRecord(value)).toThrow(message);
  expect(() => validateAuditLogRecord(value)).toThrow(SessionLogRecordValidationError);
}
