import { randomUUID } from "node:crypto";
import type { AgentSessionId } from "../../agent-ids.ts";
import type { PersistenceBackend } from "../../persistence/backend.ts";
import type { OperationMeteringRecord } from "../../metering/record.ts";
import { SubscriptionHub } from "../../observation/subscription-hub.ts";
import { createInternalInferenceId } from "../ids.ts";
import type {
  EnqueueInternalInferenceRequest,
  InternalInference,
  InternalInferenceCompletion,
  InternalInferenceEvent,
  InternalInferenceId,
  InternalInferenceManager,
  InternalInferenceMeteringOperation,
  InternalInferenceListOptions,
  InternalInferenceRun,
  InternalInferenceRunSnapshot,
  InternalInferenceSnapshot,
  InternalInferenceSnapshotPage,
  InternalInferenceStrategy,
} from "../contracts.ts";
import type { ResolvedInternalInferenceConfig } from "../config.ts";
import type { InternalInferenceRepository } from "../persistence/repository.ts";
import type {
  InternalInferenceAttemptRecord,
  InternalInferenceChainRecord,
} from "../persistence/records.ts";
import { InternalInferenceStrategyRegistry } from "../strategy/registry.ts";

export interface DefaultInternalInferenceManagerConfig {
  readonly agentSessionId: AgentSessionId;
  readonly repository: InternalInferenceRepository;
  readonly persistence: PersistenceBackend;
  readonly runtime: NonNullable<ResolvedInternalInferenceConfig["runtime"]>;
  readonly settings: ResolvedInternalInferenceConfig;
  readonly strategies: readonly InternalInferenceStrategy[];
  readonly resolveAdapterId: (
    requestedAdapterId: string | undefined,
    agentConversationId: EnqueueInternalInferenceRequest["agentConversationId"],
  ) => string | Promise<string>;
  readonly beginMetering?: (
    attempt: InternalInferenceSnapshot,
    session: { readonly internalSessionId: string; readonly model: string | null },
  ) => Promise<InternalInferenceMeteringOperation | null>;
  readonly meteringRecords?: import("../../persistence/backend.ts").MeteringRecordRetention;
  readonly pollIntervalMs?: number;
}

/** Agent-scoped durable scheduler. Purpose-specific artifact transactions remain strategies' responsibility. */
export class DefaultInternalInferenceManager implements InternalInferenceManager {
  private readonly hub = new SubscriptionHub<InternalInferenceEvent>();
  private readonly registry: InternalInferenceStrategyRegistry;
  private readonly workerId = `iiw-${randomUUID()}`;
  private readonly attempts = new Map<InternalInferenceId, AttemptHandle>();
  private readonly runs = new Map<InternalInferenceId, RunHandle>();
  private readonly active = new Map<InternalInferenceId, {
    abort: AbortController;
    leaseToken: string;
    attempt: InternalInferenceAttemptRecord;
    metering: InternalInferenceMeteringOperation | null;
  }>();
  private readonly fenced = new Set<InternalInferenceId>();
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private closed = false;
  private eventSequence = 0;

  constructor(private readonly config: DefaultInternalInferenceManagerConfig) {
    this.registry = new InternalInferenceStrategyRegistry(config.strategies);
    this.pollIntervalMs = config.pollIntervalMs ?? 250;
    this.wake();
  }

  subscribe(listener: (event: InternalInferenceEvent) => void): () => void {
    return this.hub.subscribe(listener);
  }

  async enqueue(request: EnqueueInternalInferenceRequest): Promise<InternalInferenceRun> {
    this.assertOpen();
    const strategy = this.registry.require(request.purpose, request.input.strategyId, request.input.version);
    strategy.validatePayload(request.input.payload);
    const adapterId = await this.config.resolveAdapterId(
      request.adapterId,
      request.agentConversationId,
    );
    const id = createInternalInferenceId();
    const persisted = await this.config.repository.enqueue({
      internalInferenceId: id,
      agentSessionId: this.config.agentSessionId,
      ...(request.agentConversationId ? { agentConversationId: request.agentConversationId } : {}),
      purpose: request.purpose,
      adapterId,
      ...(request.executionProfileId ? { executionProfileId: request.executionProfileId } : {}),
      input: request.input,
      ...(request.sourceCheckpointId ? { sourceCheckpointId: request.sourceCheckpointId } : {}),
      ...(request.sourceFromSequence === undefined ? {} : { sourceFromSequence: request.sourceFromSequence }),
      ...(request.sourceThroughSequence === undefined ? {} : { sourceThroughSequence: request.sourceThroughSequence }),
      ...(request.requestedThroughSequence === undefined
        ? {}
        : { requestedThroughSequence: request.requestedThroughSequence }),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });
    const run = this.ownRun(persisted.chain, persisted.attempt);
    this.wake();
    return run;
  }

  async getAttempt(id: InternalInferenceId): Promise<InternalInference | null> {
    const record = await this.config.repository.getAttempt(id);
    return record ? this.ownAttempt(record) : null;
  }

  async getRun(rootId: InternalInferenceId): Promise<InternalInferenceRun | null> {
    const chain = await this.config.repository.getChain(rootId);
    if (!chain) return null;
    const activeId = chain.activeInternalInferenceId ?? rootId;
    const attempt = await this.config.repository.getAttempt(activeId);
    if (!attempt) return null;
    return this.ownRun(chain, attempt);
  }

  async list(options: InternalInferenceListOptions = {}): Promise<InternalInferenceSnapshotPage> {
    const page = await this.config.repository.list(options);
    return Object.freeze({
      attempts: Object.freeze(page.attempts.map((record) => snapshotOf(record))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  async cancel(rootId: InternalInferenceId, reason?: string): Promise<void> {
    const current = await this.config.repository.getChain(rootId);
    if (current?.activeInternalInferenceId) {
      this.active.get(current.activeInternalInferenceId)?.abort.abort();
    }
    const chain = await this.config.repository.cancel(rootId, reason);
    await this.refreshChain(chain);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const execution of this.active.values()) execution.abort.abort();
    const deadline = Date.now() + this.config.settings.shutdownGraceMs;
    while (this.active.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    for (const [id, execution] of this.active) {
      this.fenced.add(id);
      execution.metering?.settled();
      const canRetry = execution.attempt.attemptNumber < this.config.settings.retry.maxAttempts;
      await this.config.repository.fail({
        internalInferenceId: id,
        workerId: this.workerId,
        leaseToken: execution.leaseToken,
        error: "agent shutdown interrupted internal inference",
        failureCode: "shutdown_interrupted",
        ...(canRetry ? { retry: { internalInferenceId: createInternalInferenceId() } } : {}),
      }).catch(() => undefined);
    }
    this.hub.clear();
  }

  private wake(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, 0);
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const recovered = await this.config.repository.recoverExpired({
          retryInternalInferenceId: createInternalInferenceId(),
          maxAttempts: this.config.settings.retry.maxAttempts,
        });
        if (!recovered) break;
        this.publishAttempt(recovered);
        await this.refreshRun(recovered.rootInternalInferenceId);
      }
      while (!this.closed && this.active.size < this.config.settings.maxConcurrency) {
        const leaseToken = randomUUID();
        const claimed = await this.config.repository.claimNext({
          workerId: this.workerId,
          leaseToken,
          leaseDurationMs: this.config.settings.leaseDurationMs,
        });
        if (!claimed) break;
        const abort = new AbortController();
        this.active.set(claimed.attempt.internalInferenceId, {
          abort,
          leaseToken,
          attempt: claimed.attempt,
          metering: null,
        });
        this.publishAttempt(claimed.attempt);
        void this.execute(claimed.attempt, abort, leaseToken).catch(() => {});
      }
    } finally {
      this.pumping = false;
      if (!this.closed) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.pump();
        }, this.pollIntervalMs);
      }
    }
  }

  private async execute(
    attempt: InternalInferenceAttemptRecord,
    abort: AbortController,
    leaseToken: string,
  ): Promise<void> {
    let metering: InternalInferenceMeteringOperation | null = null;
    let meteringRecord: OperationMeteringRecord | null = null;
    const heartbeat = setInterval(() => {
      void this.config.repository.heartbeat(
        attempt.internalInferenceId,
        this.workerId,
        leaseToken,
        this.config.settings.leaseDurationMs,
      );
    }, this.config.settings.heartbeatIntervalMs);
    try {
      const strategy = this.registry.require(
        attempt.purpose,
        attempt.input.strategyId,
        attempt.input.version,
      );
      this.publishProgress(attempt.internalInferenceId, "preparing_input");
      const payload = strategy.validatePayload(attempt.input.payload);
      const prepared = await strategy.prepare({ attempt: snapshotOf(attempt), signal: abort.signal }, payload);
      this.publishProgress(attempt.internalInferenceId, "starting_harness");
      const result = await this.config.runtime.run({
        internalInferenceId: attempt.internalInferenceId,
        purpose: attempt.purpose,
        agentSessionId: attempt.agentSessionId,
        ...(attempt.agentConversationId ? { agentConversationId: attempt.agentConversationId } : {}),
        adapterId: attempt.adapterId,
        prompt: prepared.prompt,
        ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
        ...(prepared.metadata ? { metadata: prepared.metadata } : {}),
      }, abort.signal, {
        stageChanged: (stage) => this.publishProgress(attempt.internalInferenceId, stage),
        sessionStarted: async (session) => {
          metering = await this.config.beginMetering?.(snapshotOf(attempt), session) ?? null;
          const active = this.active.get(attempt.internalInferenceId);
          if (active) active.metering = metering;
        },
      });
      // Custom runtimes may omit the early lifecycle notification. They lose metering
      // preflight, but their completed provider work must still be accounted for.
      if (!metering && this.config.beginMetering) {
        metering = await this.config.beginMetering(snapshotOf(attempt), {
          internalSessionId: result.internalSessionId,
          model: result.model,
        });
        const active = this.active.get(attempt.internalInferenceId);
        if (active) active.metering = metering;
      }
      if (this.fenced.has(attempt.internalInferenceId)) return;
      this.publishProgress(attempt.internalInferenceId, "persisting_result");
      const openedMetering = metering as InternalInferenceMeteringOperation | null;
      meteringRecord = openedMetering
        ? await openedMetering.close({ outcome: "completed", result })
        : null;
      if (this.fenced.has(attempt.internalInferenceId)) return;
      const completed = await this.config.persistence.transaction(async (persistence) => {
        const completion = await strategy.complete({
          attempt: snapshotOf(attempt),
          persistence,
        }, result);
        if (this.fenced.has(attempt.internalInferenceId)) {
          throw new Error("internal inference was fenced during completion");
        }
        if (meteringRecord && attempt.agentConversationId) {
          await persistence.metering.commit({
            agentConversationId: attempt.agentConversationId,
            record: meteringRecord,
            meteringRecords: this.config.meteringRecords ?? "all",
          });
        } else if (meteringRecord) {
          await persistence.metering.commitAgent({
            agentSessionId: attempt.agentSessionId,
            record: meteringRecord,
            meteringRecords: this.config.meteringRecords ?? "all",
          });
        }
        return await persistence.internalInferences!.complete({
          internalInferenceId: attempt.internalInferenceId,
          workerId: this.workerId,
          leaseToken,
          completion,
          ...(result.model ? { model: result.model } : {}),
          internalSessionId: result.internalSessionId,
          ...(meteringRecord
            ? { meteringOperationId: meteringRecord.operationId }
            : completion.meteringOperationId
              ? { meteringOperationId: completion.meteringOperationId }
              : {}),
        });
      });
      this.publishAttempt(completed);
      await this.refreshRun(attempt.rootInternalInferenceId);
      await this.pruneTerminal();
    } catch (error) {
      if (this.fenced.has(attempt.internalInferenceId)) return;
      const openedMetering = metering as InternalInferenceMeteringOperation | null;
      if (openedMetering && !meteringRecord) {
        meteringRecord = await openedMetering.close({ outcome: abort.signal.aborted ? "cancelled" : "error", error })
          .catch(() => null);
      }
      if (this.closed && abort.signal.aborted) {
        await this.recordShutdownInterruption(attempt, leaseToken, error, meteringRecord);
      } else {
        await this.recordFailure(attempt, leaseToken, error, meteringRecord);
      }
    } finally {
      clearInterval(heartbeat);
      (metering as InternalInferenceMeteringOperation | null)?.settled();
      this.active.delete(attempt.internalInferenceId);
      this.wake();
    }
  }

  private async recordShutdownInterruption(
    attempt: InternalInferenceAttemptRecord,
    leaseToken: string,
    error: unknown,
    meteringRecord: OperationMeteringRecord | null,
  ): Promise<void> {
    const canRetry = attempt.attemptNumber < this.config.settings.retry.maxAttempts;
    await this.config.persistence.transaction(async (persistence) => {
      if (meteringRecord && attempt.agentConversationId) {
        await persistence.metering.commit({
          agentConversationId: attempt.agentConversationId,
          record: meteringRecord,
          meteringRecords: this.config.meteringRecords ?? "all",
        });
      } else if (meteringRecord) {
        await persistence.metering.commitAgent({
          agentSessionId: attempt.agentSessionId,
          record: meteringRecord,
          meteringRecords: this.config.meteringRecords ?? "all",
        });
      }
      await persistence.internalInferences!.fail({
        internalInferenceId: attempt.internalInferenceId,
        workerId: this.workerId,
        leaseToken,
        error: error instanceof Error ? error.message : "agent shutdown interrupted internal inference",
        failureCode: "shutdown_interrupted",
        ...(canRetry ? { retry: { internalInferenceId: createInternalInferenceId() } } : {}),
      });
    });
  }

  private async recordFailure(
    attempt: InternalInferenceAttemptRecord,
    leaseToken: string,
    error: unknown,
    meteringRecord: OperationMeteringRecord | null,
  ): Promise<void> {
    const strategy = this.registry.get(attempt.purpose, attempt.input.strategyId, attempt.input.version);
    const disposition = strategy?.classifyError(error) ?? { kind: "terminal" as const, code: "unknown_strategy" };
    const canRetry = disposition.kind === "retryable"
      && attempt.attemptNumber < this.config.settings.retry.maxAttempts;
    const delay = retryDelay(this.config.settings.retry.backoffMs, attempt.attemptNumber);
    const failed = await this.config.persistence.transaction(async (persistence) => {
      if (meteringRecord && attempt.agentConversationId) {
        await persistence.metering.commit({
          agentConversationId: attempt.agentConversationId,
          record: meteringRecord,
          meteringRecords: this.config.meteringRecords ?? "all",
        });
      } else if (meteringRecord) {
        await persistence.metering.commitAgent({
          agentSessionId: attempt.agentSessionId,
          record: meteringRecord,
          meteringRecords: this.config.meteringRecords ?? "all",
        });
      }
      return await persistence.internalInferences!.fail({
        internalInferenceId: attempt.internalInferenceId,
        workerId: this.workerId,
        leaseToken,
        error: error instanceof Error ? error.message : String(error),
        failureCode: disposition.code,
        ...(canRetry
          ? {
              retry: {
                internalInferenceId: createInternalInferenceId(),
                nextAttemptAt: new Date(Date.now() + delay).toISOString(),
              },
            }
          : {}),
      });
    });
    this.publishAttempt(failed);
    await this.refreshRun(attempt.rootInternalInferenceId);
    if (!canRetry) await this.pruneTerminal();
  }

  private ownAttempt(record: InternalInferenceAttemptRecord): AttemptHandle {
    let handle = this.attempts.get(record.internalInferenceId);
    if (!handle) {
      handle = new AttemptHandle(record, (reason) => this.cancel(record.rootInternalInferenceId, reason));
      this.attempts.set(record.internalInferenceId, handle);
    } else handle.update(record);
    return handle;
  }

  private ownRun(chain: InternalInferenceChainRecord, attempt: InternalInferenceAttemptRecord): RunHandle {
    const ownedAttempt = this.ownAttempt(attempt);
    let run = this.runs.get(chain.rootInternalInferenceId);
    if (!run) {
      run = new RunHandle(chain, ownedAttempt, (reason) => this.cancel(chain.rootInternalInferenceId, reason));
      this.runs.set(chain.rootInternalInferenceId, run);
    } else run.update(chain, ownedAttempt);
    return run;
  }

  private publishAttempt(record: InternalInferenceAttemptRecord): void {
    const handle = this.ownAttempt(record);
    const event: InternalInferenceEvent = {
      kind: "changed",
      sequence: ++this.eventSequence,
      inferenceId: record.internalInferenceId,
      rootId: record.rootInternalInferenceId,
      revision: record.revision,
      snapshot: handle.snapshot,
    };
    handle.emit(event);
    this.hub.emit(event);
  }

  private publishProgress(id: InternalInferenceId, stage: InternalInferenceSnapshot["stage"]): void {
    const handle = this.attempts.get(id);
    if (!handle) return;
    handle.setStage(stage);
    const snapshot = handle.snapshot;
    const event: InternalInferenceEvent = {
      kind: "changed",
      sequence: ++this.eventSequence,
      inferenceId: id,
      rootId: snapshot.rootId,
      revision: snapshot.revision,
      snapshot,
    };
    handle.emit(event);
    this.hub.emit(event);
  }

  private async refreshRun(rootId: InternalInferenceId): Promise<void> {
    const chain = await this.config.repository.getChain(rootId);
    if (chain) await this.refreshChain(chain);
  }

  private async refreshChain(chain: InternalInferenceChainRecord): Promise<void> {
    const id = chain.activeInternalInferenceId ?? chain.rootInternalInferenceId;
    const attempt = await this.config.repository.getAttempt(id);
    if (attempt) this.ownRun(chain, attempt).update(chain, this.ownAttempt(attempt));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("internal inference manager is closed");
  }

  private async pruneTerminal(): Promise<void> {
    const retention = this.config.settings.retention;
    if (retention !== "all") await this.config.repository.pruneTerminal(retention.retain);
  }
}

class AttemptHandle implements InternalInference {
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

class RunHandle implements InternalInferenceRun {
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

function snapshotOf(record: InternalInferenceAttemptRecord): InternalInferenceSnapshot {
  return Object.freeze({
    id: record.internalInferenceId,
    rootId: record.rootInternalInferenceId,
    ...(record.retryOfInternalInferenceId ? { retryOfId: record.retryOfInternalInferenceId } : {}),
    revision: record.revision,
    purpose: record.purpose,
    status: record.status,
    stage: stageOf(record.status),
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

function stageOf(status: InternalInferenceSnapshot["status"]): InternalInferenceSnapshot["stage"] {
  if (status === "running") return "prompting";
  return status;
}

function retryDelay(backoff: readonly number[], attemptNumber: number): number {
  if (!backoff.length) return 0;
  return backoff[Math.min(attemptNumber - 1, backoff.length - 1)] ?? 0;
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
