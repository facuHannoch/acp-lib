import type { InternalInferenceId } from "../contracts.ts";
import type {
  ClaimInternalInferenceInput,
  ClaimedInternalInference,
  CompleteInternalInferenceInput,
  EnqueueInternalInferenceInput,
  FailInternalInferenceInput,
  InternalInferenceAttemptRecord,
  InternalInferenceChainRecord,
  InternalInferenceRecordListOptions,
  InternalInferencePage,
  RecoverExpiredInternalInferenceInput,
} from "./records.ts";

export interface InternalInferenceRepository {
  enqueue(input: EnqueueInternalInferenceInput): Promise<ClaimedInternalInference>;
  claimNext(input: ClaimInternalInferenceInput): Promise<ClaimedInternalInference | null>;
  heartbeat(
    id: InternalInferenceId,
    workerId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<InternalInferenceAttemptRecord | null>;
  complete(input: CompleteInternalInferenceInput): Promise<InternalInferenceAttemptRecord>;
  fail(input: FailInternalInferenceInput): Promise<InternalInferenceAttemptRecord>;
  recoverExpired(
    input: RecoverExpiredInternalInferenceInput,
  ): Promise<InternalInferenceAttemptRecord | null>;
  cancel(rootId: InternalInferenceId, reason?: string): Promise<InternalInferenceChainRecord>;
  getAttempt(id: InternalInferenceId): Promise<InternalInferenceAttemptRecord | null>;
  getChain(rootId: InternalInferenceId): Promise<InternalInferenceChainRecord | null>;
  list(options?: InternalInferenceRecordListOptions): Promise<InternalInferencePage>;
}
