import { describe, expect, test } from "bun:test";
import {
  CheckpointValidationError,
  createAgentSessionCheckpoint,
  validateAgentSessionCheckpoint,
  type AgentSessionCheckpointInput,
} from "../src/persistence/checkpoint.ts";
import { checkpointDigest, sha256CanonicalJson } from "../src/persistence/integrity.ts";

const NOW = "2026-09-08T12:00:00.000Z";

describe("AgentSession checkpoints", () => {
  test("creates a canonical digest over the complete continuation state", () => {
    const checkpoint = createAgentSessionCheckpoint(input());
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateAgentSessionCheckpoint(checkpoint)).not.toThrow();
  });

  test("detects mutation and identity disagreement", () => {
    const checkpoint = createAgentSessionCheckpoint(input());
    const changed = structuredClone(checkpoint) as unknown as Record<string, unknown>;
    changed.model = "another-model";
    expect(() => validateAgentSessionCheckpoint(changed)).toThrow("digest mismatch");

    expect(() => validateAgentSessionCheckpoint(checkpoint, {
      agentSessionId: "other",
    })).toThrow("agentSessionId mismatch");
    expect(() => validateAgentSessionCheckpoint(checkpoint, {
      incarnationId: "other",
    })).toThrow("incarnationId mismatch");
  });

  test("validates transcript identity, generation, and normalized path", () => {
    const checkpoint = createAgentSessionCheckpoint(input());
    expect(() => validateAgentSessionCheckpoint(checkpoint, {
      transcriptId: "transcript-1",
      transcriptGeneration: 1,
      transcriptPath: "/data/transcripts/agent-1.jsonl",
    })).not.toThrow();
    expect(() => validateAgentSessionCheckpoint(checkpoint, {
      transcriptGeneration: 2,
    })).toThrow("transcript generation mismatch");

    expectInvalid({ transcript: { transcriptId: "transcript-1", generation: 1, path: "relative", coveredSequence: 1 } }, "must be absolute");
  });

  test("requires canonical timestamps and matching configuration adapter identity", () => {
    expectInvalid({ updatedAt: "2026-09-08" }, "canonical ISO-8601");
    expectInvalid({ mode: "unknown" as never }, "mode is invalid");
    expectInvalid({
      sessionConfiguration: { ...input().sessionConfiguration, adapterId: "other" },
    }, "adapterId mismatch");
    expectInvalid({ internalSessionActivatedAt: null }, "must both be null or both be present");
    expectInvalid({ internalSessionActivatedAt: "2026-09-08T13:00:00.000Z" }, "must not be after updatedAt");
  });

  test("validates ordered restoration targets and configuration fidelity", () => {
    const first = {
      configId: "model",
      type: "select" as const,
      value: "sonnet",
      ordinal: 1,
      source: "explicit_selection" as const,
      recordedAt: NOW,
    };
    expectInvalid({
      sessionConfiguration: {
        ...input().sessionConfiguration,
        restorationTargets: [first, { ...first, configId: "mode", ordinal: 0 }],
      },
    }, "ordinals must be strictly increasing");
    expectInvalid({
      sessionConfiguration: {
        ...input().sessionConfiguration,
        announcedConfigIds: ["model"],
        omittedConfigIds: ["model"],
      },
    }, "exact session configuration cannot contain omittedConfigIds");
    expectInvalid({
      sessionConfiguration: {
        ...input().sessionConfiguration,
        announcedConfigIds: ["model"],
        omittedConfigIds: ["secret"],
        restorationFidelity: "partial",
      },
    }, "omittedConfigIds must be announced");
  });

  test("supports registry-only checkpoints", () => {
    const checkpoint = createAgentSessionCheckpoint(input({ transcript: null }));
    expect(checkpoint.transcript).toBeNull();
    expect(() => validateAgentSessionCheckpoint(checkpoint)).not.toThrow();
    expect(() => validateAgentSessionCheckpoint(checkpoint, { transcriptId: "required" }))
      .toThrow("no transcript identity");
  });

  test("rejects unsupported JSON before creating a digest", () => {
    const bad = input() as unknown as Record<string, unknown>;
    bad.extra = undefined;
    expect(() => createAgentSessionCheckpoint(bad as never)).toThrow("unsupported JSON value");
  });
});

function input(overrides: Partial<AgentSessionCheckpointInput> = {}): AgentSessionCheckpointInput {
  return {
    agentSessionId: "agent-1",
    incarnationId: "creation-1",
    stateRevision: 1,
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: "internal-1",
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

function expectInvalid(
  overrides: Partial<AgentSessionCheckpointInput>,
  message: string,
): void {
  const checkpoint = {
    version: 1,
    ...input(overrides),
    digest: "",
  } as unknown as Record<string, unknown>;
  checkpoint.digest = checkpointDigest(checkpoint);
  expect(() => validateAgentSessionCheckpoint(checkpoint)).toThrow(message);
  expect(() => validateAgentSessionCheckpoint(checkpoint)).toThrow(CheckpointValidationError);
}
