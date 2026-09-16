import type {
  ContinuationAttempt,
  ContinuationReport,
  ContinuationStrategy,
  OpenContinuationOptions,
} from "./agent-conversation-contracts.ts";
import type { AgentSessionCheckpoint } from "./persistence/checkpoint.ts";
import type { InternalSessionDescriptor } from "./persistence/records.ts";
import type { StagedContinuationState } from "./persistence/registry.ts";
import type { PersistenceStateRuntime } from "./persistence/state-runtime.ts";

export const HANDOFF_SUMMARY_PROMPT = [
  "Create portable continuation context for a new agent thread.",
  "Summarize the objective, decisions, completed work, current state, important files or identifiers,",
  "and concrete next steps. Preserve unresolved risks and constraints. Return only the continuation context.",
].join(" ");

export function buildContinuationPrompt(summary: string): string {
  return [
    "Continue this conversation using the following portable continuation context.",
    "Treat it as prior context, not as a new user request. Confirm internally and continue from this state.",
    "",
    summary,
  ].join("\n");
}

export function isReconstructionStrategy(strategy: ContinuationStrategy): boolean {
  return strategy.kind === "new_from_transcript" || strategy.kind === "new_from_consumer_continuation";
}

/** Validate and take an immutable snapshot of caller-supplied continuation policy. */
export function normalizeContinuationStrategies(
  options: OpenContinuationOptions | undefined,
): readonly ContinuationStrategy[] {
  const strategies = options?.strategies ?? [{ kind: "load_internal_session" as const }];
  if (strategies.length === 0) throw new Error("continuation.strategies cannot be empty");
  return Object.freeze(strategies.map((strategy): ContinuationStrategy => {
    if (strategy.kind === "load_internal_session") {
      return Object.freeze({ kind: strategy.kind });
    }
    if (strategy.kind === "new_from_transcript") {
      if (!strategy.strategyId.trim()) throw new Error("transcript continuation strategyId cannot be blank");
      if (typeof strategy.buildContinuation !== "function") {
        throw new Error("transcript continuation strategy requires buildContinuation");
      }
      return Object.freeze({
        kind: strategy.kind,
        strategyId: strategy.strategyId,
        buildContinuation: strategy.buildContinuation,
      });
    }
    if (!strategy.continuationId.trim()) throw new Error("consumer continuationId cannot be blank");
    if (!strategy.continuation.trim()) throw new Error("consumer continuation cannot be blank");
    return Object.freeze({
      kind: strategy.kind,
      continuationId: strategy.continuationId,
      continuation: strategy.continuation,
    });
  }));
}

export function createContinuationReport(
  checkpoint: AgentSessionCheckpoint,
  requestedAdapterId: string,
  transcript: Pick<PersistenceStateRuntime, "conversationAvailability">,
  recordedThreadAvailability: ContinuationReport["recordedThreadAvailability"],
  attempts: readonly ContinuationAttempt[],
  outcome: ContinuationReport["outcome"],
): ContinuationReport {
  return Object.freeze({
    recordedAdapterId: checkpoint.adapterId,
    recordedInternalSessionId: checkpoint.internalSessionId,
    requestedAdapterId,
    recordedConversationAvailability: transcript.conversationAvailability,
    recordedThreadAvailability,
    attempts: Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt }))),
    outcome: Object.freeze({ ...outcome }),
  });
}

export function descriptorFromCheckpoint(
  checkpoint: AgentSessionCheckpoint,
): InternalSessionDescriptor {
  return {
    internalSessionId: checkpoint.internalSessionId,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    activatedAt: checkpoint.internalSessionActivatedAt,
    protocol: checkpoint.protocol,
  };
}

/**
 * Persist and verify the provider identity acquired while opening. This is kept outside
 * the harness acquisition loop so storage coordination does not become controller logic.
 */
export async function stageOpeningContinuation(
  stage: ((state: StagedContinuationState) => Promise<StagedContinuationState>) | undefined,
  checkpoint: AgentSessionCheckpoint,
  internalSessionId: string,
): Promise<void> {
  if (!stage) return;
  const observed: StagedContinuationState = {
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    internalSessionId,
    internalSessionActivatedAt: checkpoint.internalSessionActivatedAt,
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    protocol: checkpoint.protocol,
  };
  const persisted = await stage(observed);
  if (persisted.adapterId !== observed.adapterId
    || persisted.mode !== observed.mode
    || persisted.internalSessionId !== observed.internalSessionId) {
    throw new Error("staged continuation disagrees with the loaded provider identity");
  }
}

