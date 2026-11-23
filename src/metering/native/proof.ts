import type { OperationMeteringRecord } from "../record.ts";
import type { MeteringOperationIdentity } from "../../persistence/backend.ts";
import { accountedNativeAttempts } from "./retirement.ts";

export const MAX_NATIVE_PROOF_IDS = 128;
export const MAX_NATIVE_PROOF_BYTES = 32 * 1024;
const MAX_ENCODED_ID_BYTES = 96;

type NativeProof = Pick<MeteringOperationIdentity, "nativeAccountedAttemptIds" | "nativeAccountedAttemptCount" |
  "nativeAccountedAttemptsTruncated" | "unaccountedEarlierCalls" | "unaccountedEarlierSummary">;

function boundedId(id: string): boolean {
  return id.length <= MAX_ENCODED_ID_BYTES && Buffer.byteLength(JSON.stringify(id)) <= MAX_ENCODED_ID_BYTES;
}

export function serializeNativeMeteringProof(record: OperationMeteringRecord): string | null {
  if (!record.nativeUsage) return null;
  const accounted = accountedNativeAttempts(record);
  const ids = accounted?.slice(0, MAX_NATIVE_PROOF_IDS).filter(boundedId);
  const retained: NativeProof = {
    nativeAccountedAttemptIds: ids,
    ...(accounted && ids?.length !== accounted.length ? {
      nativeAccountedAttemptCount: accounted.length, nativeAccountedAttemptsTruncated: true,
    } : {}),
  };
  const earlier = record.nativeUsage.unaccountedEarlierCalls;
  if (!earlier?.length) return JSON.stringify(retained);

  if (earlier.length <= MAX_NATIVE_PROOF_IDS && earlier.every(call =>
    boundedId(call.callId) && boundedId(call.turnId) && call.attemptIds.length <= MAX_NATIVE_PROOF_IDS &&
    call.attemptIds.every(boundedId) && (call.reason?.length ?? 0) <= 160)) {
    const full = JSON.stringify({ ...retained, unaccountedEarlierCalls: earlier });
    if (Buffer.byteLength(full) <= MAX_NATIVE_PROOF_BYTES) return full;
  }

  let attemptCount = 0, unmeasured = 0, measuredCalls = 0;
  const tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const call of earlier) {
    attemptCount += call.attemptCount;
    unmeasured += call.unmeasured;
    if (!call.tokens) continue;
    measuredCalls++;
    tokens.inputTokens += call.tokens.inputTokens;
    tokens.outputTokens += call.tokens.outputTokens;
    tokens.totalTokens += call.tokens.totalTokens;
  }
  return JSON.stringify({ ...retained, unaccountedEarlierSummary: {
    truncated: true, callCount: earlier.length, attemptCount, unmeasured,
    ...(measuredCalls ? { tokens } : {}),
  } });
}
