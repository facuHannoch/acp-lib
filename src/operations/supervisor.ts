import { stalePolicy, validateStaleLimits, type StallPhase } from "./stale-policy.ts";
import { OperationStalledError } from "./errors.ts";
import type { StaleLimits } from "./contracts.ts";
import type { PromptResult } from "../types.ts";
import type { CancelReason, OperationActivity, SupervisedOperationKind, OutputListener, ProviderOutput } from "./contracts.ts";
import { ToolTracker } from "./activity-tracker.ts";
import { realTimers, type Timers } from "./timers.ts";
export interface SupervisedProvider {
  prompt(): Promise<PromptResult>;
  subscribeOutput(listener: OutputListener): () => void;
  cancel(): void;
  forceStop(): Promise<void>;
}
export interface SupervisorOptions {
  readonly operationId: string;
  readonly kind: SupervisedOperationKind;
  readonly sessionId?: string | null;
  readonly cancelGraceMs?: number;
  readonly timers?: Timers;
  readonly limits?: StaleLimits;
  readonly onStageChanged?: (activity: OperationActivity) => void;
  readonly onToolBoundary?: () => void;
}
/** Owns timing and cancellation for exactly one provider request. Never retains content. */
export class OperationSupervisor {
  readonly tools = new ToolTracker();
  private readonly timers: Timers;
  private readonly startedAt: number;
  private lastOutputAt: number | null = null;
  private permissions = 0;
  private cancellation?: { reason: CancelReason; requestedAt: number };
  private stage: OperationActivity["stage"] = "waiting";
  private handles: unknown[] = [];
  private staleHandle: unknown;
  private stallPhase?: StallPhase;
  private finished = false;
  private started = false;
  private forced = false;
  private finishForced?: (result: PromptResult) => void;
  constructor(private readonly provider: SupervisedProvider, private readonly options: SupervisorOptions) {
    validateStaleLimits(options.limits ?? {});
    if (options.cancelGraceMs !== undefined && (!Number.isFinite(options.cancelGraceMs) || options.cancelGraceMs <= 0)) throw new Error("cancelGraceMs must be positive and finite");
    this.timers = options.timers ?? realTimers;
    this.startedAt = this.timers.now();
  }
  get activity(): OperationActivity {
    return Object.freeze({ operationId: this.options.operationId, kind: this.options.kind, stage: this.stage,
      startedAt: this.startedAt, lastOutputAt: this.lastOutputAt, toolsInFlight: this.tools.inFlight,
      ...(this.cancellation ? { cancel: Object.freeze({ ...this.cancellation }) } : {}) });
  }
  private publishStage(): void {
    const stage = this.cancellation ? "cancelling" : this.permissions ? "awaiting_permission"
      : this.tools.inFlight ? "tool_running" : this.lastOutputAt === null ? "waiting" : "streaming";
    if (stage === this.stage) return;
    this.stage = stage;
    this.options.onStageChanged?.(this.activity);
  }
  private observe(output: ProviderOutput): void {
    if (this.finished || (output.sessionId && this.options.sessionId && output.sessionId !== this.options.sessionId)) return;
    this.lastOutputAt = this.timers.now();
    if (output.kind === "permission_started") this.permissions++;
    if (output.kind === "permission_ended") this.permissions = Math.max(0, this.permissions - 1);
    if (output.kind === "update" && output.activity) {
      const settled = this.tools.observe(output.activity, this.lastOutputAt);
      if (settled && !this.tools.inFlight) this.options.onToolBoundary?.();
    }
    this.publishStage();
    this.armStaleTimer();
  }
  private armStaleTimer(): void {
    this.timers.clearTimeout(this.staleHandle);
    const decision = stalePolicy(this.activity, this.permissions, this.tools.oldestStartedAt, this.options.limits ?? {}, this.timers.now());
    if (!decision || this.finished) return;
    this.staleHandle = this.timers.setTimeout(() => {
      this.stallPhase = decision.phase;
      this.cancel("stalled");
    }, Math.max(0, decision.deadline - this.timers.now()));
  }
  private sendCancel(): void {
    try { this.provider.cancel(); } catch { /* Escalation still bounds a broken notification transport. */ }
  }
  cancel(reason: CancelReason): void {
    if (this.finished || this.cancellation) return;
    this.timers.clearTimeout(this.staleHandle);
    this.cancellation = { reason, requestedAt: this.timers.now() };
    this.publishStage();
    this.sendCancel();
    const grace = this.options.cancelGraceMs ?? 30_000;
    this.handles.push(this.timers.setTimeout(() => { if (!this.finished) this.sendCancel(); }, grace / 2));
    this.handles.push(this.timers.setTimeout(() => {
      if (this.finished) return;
      this.forced = true;
      // Start teardown before releasing the queue; reconnect waits for teardown in the controller.
      void Promise.resolve().then(() => this.provider.forceStop()).catch(() => {});
      this.finishForced?.({ text: "", messages: Object.freeze([]), stopReason: "cancelled", status: "cancelled", usage: null, cancel: "forced" });
    }, grace));
  }
  async run(): Promise<PromptResult> {
    if (this.started) throw new Error("operation supervisor can only run once");
    this.started = true;
    const detach = this.provider.subscribeOutput((output) => this.observe(output));
    this.options.onStageChanged?.(this.activity);
    this.armStaleTimer();
    try {
      const forced = new Promise<PromptResult>((resolve) => { this.finishForced = resolve; });
      const result = await Promise.race([Promise.resolve().then(() => this.provider.prompt()), forced]);
      if (this.stallPhase) {
        const error = new OperationStalledError(this.options.operationId, this.stallPhase);
        error.cancel = this.forced ? "forced" : "acknowledged";
        throw error;
      }
      return this.cancellation && result.status === "cancelled" ? { ...result, cancel: this.forced ? "forced" : "acknowledged" } : result;
    } catch (error) {
      if (this.stallPhase) {
        const stalled = error instanceof OperationStalledError ? error : new OperationStalledError(this.options.operationId, this.stallPhase);
        stalled.cancel = this.forced ? "forced" : "acknowledged";
        throw stalled;
      }
      if (this.forced) return { text: "", messages: Object.freeze([]), stopReason: "cancelled", status: "cancelled", usage: null, cancel: "forced" };
      throw error;
    } finally {
      this.finished = true;
      this.timers.clearTimeout(this.staleHandle);
      detach();
      for (const handle of this.handles) this.timers.clearTimeout(handle);
      this.handles = [];
    }
  }
}
