import { SubscriptionHub } from "../../observation/subscription-hub.ts";
import type {
  InternalInference,
  InternalInferenceCompletion,
  InternalInferenceEvent,
  InternalInferenceId,
  InternalInferenceRun,
  InternalInferenceRunSnapshot,
  InternalInferenceSnapshot,
} from "../contracts.ts";
import type {
  InternalInferenceAttemptRecord,
  InternalInferenceChainRecord,
} from "../persistence/records.ts";

export class AttemptHandle implements InternalInference {
  private readonly hub = new SubscriptionHub<InternalInferenceEvent>();
  private current: InternalInferenceSnapshot;
  private readonly deferred = promiseWithResolvers<InternalInferenceCompletion>();
  readonly result = this.deferred.promise;

  constructor(record: InternalInferenceAttemptRecord, private readonly cancelRun: (reason?: string) => Promise<void>) {
    this.current = snapshotOf(record);
    this.result.catch(() => {});
    this.settle(record);
  }

  get id(): InternalInferenceId { return this.current.id; }
  get snapshot(): InternalInferenceSnapshot { return this.current; }
  subscribe(listener: (event: InternalInferenceEvent) => void): () => void { return this.hub.subscribe(listener); }
  cancel(): Promise<void> { return this.cancelRun(); }
  emit(event: InternalInferenceEvent): void { this.hub.emit(event); }
  update(record: InternalInferenceAttemptRecord): void {
    if (record.revision < this.current.revision) return;
    this.current = snapshotOf(record);
    this.settle(record);
  }
  setStage(stage: InternalInferenceSnapshot["stage"]): void {
    if (this.current.status !== "running") return;
    this.current = Object.freeze({ ...this.current, stage });
  }
  private settle(record: InternalInferenceAttemptRecord): void {
    if (record.status === "completed" && record.completion) this.deferred.resolve(record.completion);
    if (record.status === "failed" || record.status === "cancelled") {
      this.deferred.reject(new Error(record.error ?? `internal inference ${record.status}`));
    }
  }
}

export class RunHandle implements InternalInferenceRun {
  private readonly hub = new SubscriptionHub<InternalInferenceEvent>();
  private current: InternalInferenceRunSnapshot;
  private attempt: InternalInference;
  private readonly deferred = promiseWithResolvers<InternalInferenceCompletion>();
  readonly result = this.deferred.promise;

  constructor(
    chain: InternalInferenceChainRecord,
    attempt: InternalInference,
    private readonly cancelRun: (reason?: string) => Promise<void>,
  ) {
    this.current = runSnapshotOf(chain);
    this.attempt = attempt;
    this.result.catch(() => {});
    this.settle(chain, attempt);
  }
  get rootId(): InternalInferenceId { return this.current.rootId; }
  get activeAttempt(): InternalInference { return this.attempt; }
  get snapshot(): InternalInferenceRunSnapshot { return this.current; }
  subscribe(listener: (event: InternalInferenceEvent) => void): () => void { return this.hub.subscribe(listener); }
  cancel(): Promise<void> { return this.cancelRun(); }
  update(chain: InternalInferenceChainRecord, attempt: InternalInference): void {
    if (chain.revision < this.current.revision) return;
    this.current = runSnapshotOf(chain);
    this.attempt = attempt;
    this.settle(chain, attempt);
  }
  private settle(chain: InternalInferenceChainRecord, attempt: InternalInference): void {
    if (chain.status === "completed") void attempt.result.then(this.deferred.resolve, this.deferred.reject);
    if (chain.status === "failed" || chain.status === "cancelled") {
      this.deferred.reject(new Error(chain.error ?? `internal inference run ${chain.status}`));
    }
  }
}

export function snapshotOf(record: InternalInferenceAttemptRecord): InternalInferenceSnapshot {
  return Object.freeze({
    id: record.internalInferenceId,
    rootId: record.rootInternalInferenceId,
    ...(record.retryOfInternalInferenceId ? { retryOfId: record.retryOfInternalInferenceId } : {}),
    revision: record.revision,
    purpose: record.purpose,
    status: record.status,
    stage: record.status === "running" ? "prompting" : record.status,
    adapterId: record.adapterId,
    ...(record.agentConversationId ? { agentConversationId: record.agentConversationId } : {}),
    requestedAt: record.requestedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    attemptNumber: record.attemptNumber,
    ...(record.error ? { error: record.error } : {}),
  });
}

function runSnapshotOf(chain: InternalInferenceChainRecord): InternalInferenceRunSnapshot {
  return Object.freeze({
    rootId: chain.rootInternalInferenceId,
    status: chain.status,
    revision: chain.revision,
    ...(chain.activeInternalInferenceId ? { activeAttemptId: chain.activeInternalInferenceId } : {}),
    ...(chain.requestedThroughSequence === undefined ? {} : { requestedThroughSequence: chain.requestedThroughSequence }),
    ...(chain.error ? { error: chain.error } : {}),
  });
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
