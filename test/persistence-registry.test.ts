import { describe, expect, test } from "bun:test";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import {
  AgentSessionRecordValidationError,
  internalSessionHistoryDigest,
  validateAgentSessionRecord,
  type AgentSessionRecord,
} from "../src/persistence/registry.ts";

const NOW = "2026-09-08T12:00:00.000Z";

describe("agent-session registry records", () => {
  test("accepts a registry-only record whose projections match its checkpoint", () => {
    expect(() => validateAgentSessionRecord(record())).not.toThrow();
  });

  test("rejects materialized routing projections that disagree with continuation authority", () => {
    expectInvalid({ ...record(), model: "another-model" }, "model projection disagrees");
    expectInvalid({ ...record(), adapterId: "claude" }, "adapterId mismatch");
  });

  test("checks complete history revision and digest without embedding it in the checkpoint", () => {
    expectInvalid({
      ...record(),
      internalSessionHistory: [{ internalSessionId: "old" }],
    }, "internalSessionHistory revision disagrees");

    const base = record();
    const badCheckpoint = createAgentSessionCheckpoint({
      ...checkpointInput(),
      internalSessionHistoryDigest: "a".repeat(64),
    });
    expectInvalid({ ...base, checkpoint: badCheckpoint }, "internalSessionHistory digest disagrees");
  });

  test("requires absolute log destinations and exact transcript identity projection", () => {
    const base = record();
    const checkpoint = createAgentSessionCheckpoint({
      ...checkpointInput(),
      transcript: {
        transcriptId: "transcript-1",
        generation: 1,
        path: "/data/transcripts/agent-1.jsonl",
        coveredSequence: 1,
      },
    });
    const transcript = {
      path: "/data/transcripts/agent-1.jsonl",
      transcriptId: "transcript-1",
      generation: 1,
      preset: "activity" as const,
      effectivePolicy: {
        messages: "text" as const,
        reasoning: "none" as const,
        tools: "metadata" as const,
        lifecycle: true,
        transitions: "metadata" as const,
        permissions: "decision" as const,
        usage: true,
        configuration: "selections" as const,
        protocol: "none" as const,
      },
      effectiveLimits: {
        maxRecordBytes: 1_048_576,
        maxCapturedFieldBytes: 262_144,
        maxJsonDepth: 64,
        maxCursorBytes: 4_096,
      },
      includeTruncationDigests: false,
    };
    expect(() => validateAgentSessionRecord({ ...base, checkpoint, transcript })).not.toThrow();
    expectInvalid({ ...base, checkpoint, transcript: { ...transcript, transcriptId: "other" } }, "identity projection disagrees");
    expectInvalid({ ...base, checkpoint, transcript: { ...transcript, path: "relative.jsonl" } }, "path must be absolute");
  });
});

function checkpointInput() {
  return {
    agentSessionId: "agent-1",
    incarnationId: "creation-1",
    stateRevision: 1,
    adapterId: "opencode",
    mode: "normal" as const,
    internalSessionId: "provider-1",
    internalSessionActivatedAt: NOW,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: internalSessionHistoryDigest([]),
    model: "anthropic/claude-sonnet-4-5",
    sessionConfiguration: {
      adapterId: "opencode",
      schemaDigest: null,
      announcedConfigIds: [],
      restorationTargets: [],
      effective: {},
      omittedConfigIds: [],
      restorationFidelity: "exact" as const,
      observedAt: NOW,
    },
    protocol: { name: "acp" as const, version: 1 },
    transcript: null,
    boundary: { status: "settled" as const, lastSettledOperationId: null },
    updatedAt: NOW,
  };
}

function record(): AgentSessionRecord {
  const input = checkpointInput();
  return {
    agentSessionId: input.agentSessionId,
    incarnationId: input.incarnationId,
    recordRevision: 1,
    checkpoint: createAgentSessionCheckpoint(input),
    adapterId: input.adapterId,
    mode: input.mode,
    internalSessionId: input.internalSessionId,
    internalSessionActivatedAt: input.internalSessionActivatedAt,
    internalSessionHistory: [],
    model: input.model,
    sessionConfiguration: input.sessionConfiguration,
    protocol: input.protocol,
    transcript: null,
    auditLog: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastOpenedAt: NOW,
  };
}

function expectInvalid(value: unknown, message: string): void {
  expect(() => validateAgentSessionRecord(value)).toThrow(message);
  expect(() => validateAgentSessionRecord(value)).toThrow(AgentSessionRecordValidationError);
}
