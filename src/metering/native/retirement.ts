import type { NativeEarlierCallEvidence, OperationMeteringRecord } from "../record.ts";
import type { TokenUsage } from "../../types.ts";
import type { ModelCallSummary } from "../../native-harness/src/client.ts";
import { isSealedNativeCall, projectNativeUsage, type NativeUsageInference } from "./projection.ts";
import type { UnallocatedUsageAccrual } from "../state.ts";
import type { NativeAttemptReceipt, NativeTurnMetering, NativeTurnRead } from "./source.ts";

export function sumNativeTokens(inferences: readonly NativeUsageInference[]): TokenUsage {
  const sum = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const { tokens } of inferences) {
    sum.inputTokens += tokens.inputTokens;
    sum.outputTokens += tokens.outputTokens;
    sum.totalTokens += tokens.totalTokens;
  }
  return sum;
}

/** Only publish observations within the retired prefix. The record and cursor commit together. */
interface NativeRetirement {
  readonly through?: string;
  readonly earlier: readonly NativeEarlierCallEvidence[];
  readonly unallocated: readonly UnallocatedUsageAccrual[];
  readonly pendingEarlier: boolean;
}

export async function evaluateNativeRetirement(
  turn: NativeTurnMetering,
  read: NativeTurnRead,
  currentTerminal: boolean,
): Promise<NativeRetirement> {
  const prefix = read.prefix ?? [];
  const earlierIds = [...new Set(prefix.filter(call => call.turnId !== turn.turnId).map(call => call.turnId))];
  // One bounded reconcile read per close. A later close can continue past this batch.
  const terminal = earlierIds.length
    ? await turn.terminalEarlierTurns?.(earlierIds.slice(0, 100)).catch(() => undefined)
    : undefined;
  const prior = new Map<string, NativeAttemptReceipt | null | undefined>();
  const earlier: NativeEarlierCallEvidence[] = [];
  const unallocated: UnallocatedUsageAccrual[] = [];
  let through: string | undefined;

  for (const call of prefix) {
    if (call.turnId === turn.turnId) {
      if (!currentTerminal || read.unmeasured || !read.inferences.length) break;
    } else {
      if (!terminal?.has(call.turnId)) return { through, earlier, unallocated, pendingEarlier: true };
      if (!prior.has(call.turnId)) prior.set(call.turnId, await turn.accountedAttempts?.(call.turnId));
      const observed = earlierEvidence(call, prior.get(call.turnId));
      if (observed) {
        earlier.push(observed.evidence);
        unallocated.push(...observed.newlyKnown.map(({ tokens }) => ({
          usage: tokens, ratedCost: null, reason: "unaccounted usage of an earlier turn",
        })));
      }
    }
    through = call.callId;
  }
  return { through, earlier, unallocated, pendingEarlier: false };
}

/** Retained records from before explicit attempt proofs can attest only complete measurements. */
export function accountedNativeAttempts(record: OperationMeteringRecord): readonly string[] | undefined {
  const evidence = record.nativeUsage;
  if (!evidence) return undefined;
  if (evidence.accountedAttemptIds) return evidence.accountedAttemptIds;
  if (record.usage.status !== "metered") return [];
  return evidence.status === "observed" && evidence.unmeasured === 0
    ? evidence.calls.flatMap(call => call.attempts.map(attempt => attempt.attemptId))
    : undefined;
}

function earlierEvidence(call: ModelCallSummary, accounted: NativeAttemptReceipt | null | undefined) {
  const already = new Set(accounted?.ids ?? []);
  const attemptIds = call.attempts.filter(attempt => !already.has(attempt.attemptId)).map(attempt => attempt.attemptId);
  const { inferences } = projectNativeUsage([call], "");
  const uncertain = accounted === undefined || accounted?.truncated;
  const newlyKnown = uncertain ? [] : inferences.filter(inference => !already.has(inference.attemptId));
  const sealed = isSealedNativeCall(call);
  const unmeasured = Math.max(sealed && call.attempts.length ? 0 : 1, attemptIds.length - newlyKnown.length);
  if (!attemptIds.length && !unmeasured) return undefined;
  return {
    newlyKnown,
    evidence: {
      callId: call.callId, turnId: call.turnId, attemptIds, attemptCount: attemptIds.length, unmeasured,
      ...(newlyKnown.length ? { tokens: sumNativeTokens(newlyKnown) } : {}),
      ...(!sealed ? { reason: "the earlier turn ended with an unsealed model call" }
        : accounted?.truncated ? { reason: "the earlier operation's retained accounting proof was truncated" }
        : accounted === undefined ? { reason: "the earlier operation's retained accounting proof is unavailable" }
        : unmeasured ? { reason: "some earlier model-call attempts could not be measured" } : {}),
    },
  };
}
