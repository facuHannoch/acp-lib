import type { ModelAttemptSummary, ModelCallSummary, ModelUsage } from "../../native-harness/src/client.ts";
import type { TokenUsage } from "../../types.ts";
import { isTokenCount } from "../categories.ts";
import type { ProviderInference } from "../opencode/channel.ts";

export interface NativeAttemptEvidence {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly outcome: ModelAttemptSummary["outcome"];
  readonly usage?: Readonly<ModelUsage>;
}

export interface NativeCallEvidence {
  readonly callId: string;
  readonly channel: string;
  readonly turnId: string;
  readonly outcome: ModelCallSummary["outcome"];
  readonly attempts: readonly NativeAttemptEvidence[];
}

export interface NativeUsageInference extends ProviderInference {
  /** Empty is the internal representation of unknown, required by the string-only source shape. */
  readonly providerID: "";
  readonly modelID: "";
  readonly callId: string;
  readonly attemptId: string;
}

interface NativeUsageProjection {
  readonly evidence: readonly NativeCallEvidence[];
  readonly inferences: readonly NativeUsageInference[];
  readonly unmeasured: number;
}

const callOutcomes = new Set<ModelCallSummary["outcome"]>([
  "running", "succeeded", "failed", "incomplete", "output_limit", "timeout", "interrupted",
]);
const attemptOutcomes = new Set<ModelAttemptSummary["outcome"]>([
  "running", "succeeded", "transient_failure", "invalid_request", "invalid_config", "provider_failure",
  "incomplete", "output_limit", "timeout", "interrupted",
]);
const usageFields = ["inputTokens", "outputTokens", "totalTokens"] as const;

export function projectNativeUsage(calls: readonly ModelCallSummary[], sessionID: string): NativeUsageProjection {
  const evidence: NativeCallEvidence[] = [];
  const inferences: NativeUsageInference[] = [];
  let unmeasured = 0;

  for (const call of calls) {
    if (!Array.isArray(call.attempts) || typeof call.messageId !== "string" ||
      !call.messageId || !callOutcomes.has(call.outcome)) {
      throw new Error("Invalid native model-call summary");
    }
    const sealed = call.outcome !== "running" && timestamp(call.endedAt) !== undefined;
    const attempts: NativeAttemptEvidence[] = [];
    const ids = new Set<string>();
    for (const attempt of call.attempts) {
      if (typeof attempt?.attemptId !== "string" || !attempt.attemptId ||
        ids.has(attempt.attemptId) || attempt.ordinal !== attempts.length) {
        throw new Error("Native usage ledger returned an invalid or repeated attempt ID or ordinal");
      }
      if (!attemptOutcomes.has(attempt.outcome)) throw new Error("Invalid native model-attempt outcome");
      ids.add(attempt.attemptId);
      const usage = copyUsage(attempt.usage);
      attempts.push({
        attemptId: attempt.attemptId, ordinal: attempt.ordinal, outcome: attempt.outcome,
        ...(usage === undefined ? {} : { usage }),
      });

      const completedAt = timestamp(attempt.endedAt);
      const tokens = completeUsage(usage);
      if (!sealed || attempt.outcome === "running" || completedAt === undefined || tokens === undefined) {
        unmeasured++;
        continue;
      }
      inferences.push({
        sequence: null, sessionID, messageID: call.messageId, callId: call.callId, attemptId: attempt.attemptId,
        providerID: "", modelID: "", summary: false, completedAt, cost: null, tokens,
      });
    }
    if (!attempts.length) unmeasured++;
    evidence.push({ callId: call.callId, channel: call.channel, turnId: call.turnId, outcome: call.outcome, attempts });
  }

  return { evidence, inferences, unmeasured };
}

function timestamp(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function copyUsage(usage: ModelUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) throw new Error("Invalid native model usage");
  const copy: ModelUsage = {};
  for (const field of usageFields) {
    const value = usage[field];
    if (value === undefined) continue;
    if (!isTokenCount(value)) throw new Error(`Invalid native model usage field "${field}"`);
    copy[field] = value;
  }
  return copy;
}

function completeUsage(usage: ModelUsage | undefined): TokenUsage | undefined {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined || usage.totalTokens === undefined) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
}
