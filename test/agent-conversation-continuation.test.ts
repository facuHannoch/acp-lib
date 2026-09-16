import { describe, expect, test } from "bun:test";
import {
  buildContinuationPrompt,
  createContinuationReport,
  isReconstructionStrategy,
  normalizeContinuationStrategies,
  stageOpeningContinuation,
} from "../src/agent-conversation-continuation.ts";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { EMPTY_HISTORY_DIGEST } from "../src/persistence/reducer.ts";

function checkpoint() {
  return createAgentSessionCheckpoint({
    agentSessionId: "legacy-logical-id",
    incarnationId: "incarnation",
    stateRevision: 1,
    adapterId: "codex",
    mode: "normal",
    internalSessionId: "provider-thread",
    internalSessionActivatedAt: "2026-09-16T00:00:00.000Z",
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST,
    model: null,
    sessionConfiguration: {
      adapterId: "codex",
      schemaDigest: null,
      announcedConfigIds: [],
      restorationTargets: [],
      effective: {},
      omittedConfigIds: [],
      restorationFidelity: "exact",
      observedAt: "2026-09-16T00:00:00.000Z",
    },
    protocol: { name: "acp", version: 1 },
    transcript: null,
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
}

describe("conversation continuation policy", () => {
  test("defaults to load-only and snapshots caller policy", () => {
    expect(normalizeContinuationStrategies(undefined)).toEqual([{ kind: "load_internal_session" }]);

    const source = [{
      kind: "new_from_consumer_continuation" as const,
      continuationId: "portable-1",
      continuation: "state",
    }];
    const normalized = normalizeContinuationStrategies({ strategies: source });
    source[0] = { ...source[0]!, continuation: "mutated" };

    expect(normalized).toEqual([{
      kind: "new_from_consumer_continuation",
      continuationId: "portable-1",
      continuation: "state",
    }]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(isReconstructionStrategy(normalized[0]!)).toBe(true);
  });

  test("rejects empty and blank reconstruction policies", () => {
    expect(() => normalizeContinuationStrategies({ strategies: [] })).toThrow("cannot be empty");
    expect(() => normalizeContinuationStrategies({
      strategies: [{
        kind: "new_from_consumer_continuation",
        continuationId: "id",
        continuation: "  ",
      }],
    })).toThrow("cannot be blank");
  });

  test("builds an immutable report detached from mutable attempts", () => {
    const attempts = [{
      strategy: "load_internal_session" as const,
      status: "failed" as const,
      reason: "unavailable",
    }];
    const report = createContinuationReport(
      checkpoint(),
      "atlas",
      { conversationAvailability: "partial" },
      "unavailable",
      attempts,
      { kind: "unavailable" },
    );
    attempts[0]!.reason = "changed";

    expect(report.attempts[0]?.reason).toBe("unavailable");
    expect(report.recordedConversationAvailability).toBe("partial");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.attempts)).toBe(true);
  });

  test("stages the exact loaded provider identity and rejects disagreement", async () => {
    const value = checkpoint();
    let observed: unknown;
    await stageOpeningContinuation(async (state) => {
      observed = state;
      return state;
    }, value, "loaded-thread");
    expect(observed).toMatchObject({
      adapterId: "codex",
      mode: "normal",
      internalSessionId: "loaded-thread",
    });

    await expect(stageOpeningContinuation(async (state) => ({
      ...state,
      internalSessionId: "wrong-thread",
    }), value, "loaded-thread")).rejects.toThrow("disagrees");
  });

  test("constructs portable continuation text without changing its content", () => {
    const prompt = buildContinuationPrompt("line one\nline two");
    expect(prompt).toEndWith("line one\nline two");
  });
});
