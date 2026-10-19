// OperationSupervisor — owns timing and cancellation for exactly one provider request: its stage,
// the stale conditions, the cancel escalation (cancel, cancel again, then kill the process) and the
// reason it ended. It never holds or rewrites content; updates keep their own path to the
// conversation, and the supervisor is one more observer of them.

import { stalePolicy, validateStaleLimits, type StallPhase } from "./stale-policy.ts";
import { OperationStalledError } from "./errors.ts";
import type { PromptResult } from "../types.ts";
import type {
  CancelReason,
  OperationActivity,
  OutputListener,
  ProviderOutput,
  StaleLimits,
  SupervisedOperationKind,
} from "./contracts.ts";
import { ToolTracker } from "./activity-tracker.ts";
import { realTimers, type Timers } from "./timers.ts";

/** The narrow view of a provider the supervisor needs. */
export interface SupervisedProvider {
  prompt(): Promise<PromptResult>;
  subscribeOutput(listener: OutputListener): () => void;
  cancel(): void;
  forceStop(): Promise<void>;
}

export interface SupervisorOptions {
  readonly operationId: string;
  readonly kind: SupervisedOperationKind;
  /** Output for another session is ignored. */
  readonly sessionId?: string | null;
  /** How long a cancel may take before the process is killed. Default 30 000. */
  readonly cancelGraceMs?: number;
  readonly timers?: Timers;
  readonly limits?: StaleLimits;
  readonly onStageChanged?: (activity: OperationActivity) => void;
  /** The last running tool settled. */
  readonly onToolBoundary?: () => void;
}

const forcedResult = (): PromptResult => ({
  text: "",
  messages: Object.freeze([]),
  stopReason: "cancelled",
  status: "cancelled",
  usage: null,
  cancel: "forced",
});

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
    const grace = options.cancelGraceMs;
    if (grace !== undefined && (!Number.isFinite(grace) || grace <= 0)) {
      throw new Error("cancelGraceMs must be positive and finite");
    }
    this.timers = options.timers ?? realTimers;
    this.startedAt = this.timers.now();
  }

  get activity(): OperationActivity {
    return Object.freeze({
      operationId: this.options.operationId,
      kind: this.options.kind,
      stage: this.stage,
      startedAt: this.startedAt,
      lastOutputAt: this.lastOutputAt,
      toolsInFlight: this.tools.inFlight,
      ...(this.cancellation ? { cancel: Object.freeze({ ...this.cancellation }) } : {}),
    });
  }

  /** Ask the provider to stop. Ends within the cancel grace whatever the provider does. */
  cancel(reason: CancelReason): void {
    if (this.finished || this.cancellation) return;
    this.timers.clearTimeout(this.staleHandle);
    this.cancellation = { reason, requestedAt: this.timers.now() };
    this.publishStage();
    this.sendCancel();
    const grace = this.options.cancelGraceMs ?? 30_000;
    this.handles.push(this.timers.setTimeout(() => {
      if (!this.finished) this.sendCancel();
    }, grace / 2));
    this.handles.push(this.timers.setTimeout(() => {
      if (this.finished) return;
      this.forced = true;
      // Start teardown before releasing the queue; reconnect waits for teardown in the controller.
      void Promise.resolve().then(() => this.provider.forceStop()).catch(() => {});
      this.finishForced?.(forcedResult());
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
      // A cancel can lose the race with a normal ending: the turn is then complete, even when the
      // stall policy asked for the cancel.
      if (this.stallPhase && result.status === "cancelled") throw this.stalled();
      if (this.cancellation && result.status === "cancelled") {
        return { ...result, cancel: this.forced ? "forced" : "acknowledged" };
      }
      return result;
    } catch (error) {
      if (this.stallPhase) throw error instanceof OperationStalledError ? this.markCancel(error) : this.stalled();
      if (this.forced) return forcedResult();
      throw error;
    } finally {
      this.finished = true;
      this.timers.clearTimeout(this.staleHandle);
      detach();
      for (const handle of this.handles) this.timers.clearTimeout(handle);
      this.handles = [];
    }
  }

  private stalled(): OperationStalledError {
    return this.markCancel(new OperationStalledError(this.options.operationId, this.stallPhase!));
  }

  private markCancel(error: OperationStalledError): OperationStalledError {
    error.cancel = this.forced ? "forced" : "acknowledged";
    return error;
  }

  private publishStage(): void {
    const stage = this.cancellation ? "cancelling"
      : this.permissions ? "awaiting_permission"
      : this.tools.inFlight ? "tool_running"
      : this.lastOutputAt === null ? "waiting"
      : "streaming";
    if (stage === this.stage) return;
    this.stage = stage;
    this.options.onStageChanged?.(this.activity);
  }

  private observe(output: ProviderOutput): void {
    if (this.finished) return;
    if (output.sessionId && this.options.sessionId && output.sessionId !== this.options.sessionId) return;
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
    const limits = this.options.limits ?? {};
    const decision = stalePolicy(this.activity, this.permissions, this.tools.oldestStartedAt, limits, this.timers.now());
    if (!decision || this.finished) return;
    this.staleHandle = this.timers.setTimeout(() => {
      this.stallPhase = decision.phase;
      this.cancel("stalled");
    }, Math.max(0, decision.deadline - this.timers.now()));
  }

  private sendCancel(): void {
    try {
      this.provider.cancel();
    } catch {
      // Escalation still bounds a broken notification transport.
    }
  }
}
