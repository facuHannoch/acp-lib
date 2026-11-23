import { ownPermissions } from "../permissions/policy.ts";
import type { PermissionSettings } from "../permissions/matcher.ts";
import { workerPermissionHandler, type FindGivingConversation } from "./permissions.ts";
import { WorkerPolicyError } from "../errors.ts";
import { canSeeWorker, checkWorkerOpenLimit, requireWorkerRedirect, requireWorkerUse } from "./policy.ts";
import type { AssignmentPlan, WorkerAssignmentPort } from "./assignments.ts";
import { planAssignment } from "./busy.ts";
import type { AgentConversationManager, DeleteConversationResult } from "../agent/config.ts";
import { workerTerminalFailure } from "../persistence/worker-terminal-reason.ts";
import type { Logger } from "../logger.ts";
import type { WorkerPersistence, WorkerRow } from "../persistence/workers.ts";
import type { OrchestratorConfig } from "./config.ts";
import type { OpenWorkerResult, SendWorkerInput, SendWorkerResult, WorkerActor, WorkerEvent, WorkerInput, WorkerSummary } from "./contracts.ts";
import { WorkerPool } from "./pool.ts";
import { WorkerAssignmentConflict } from "./durable-assignments.ts";

export class Orchestrator {
  private readonly pool: WorkerPool;
  private readonly completions = new Set<Promise<void>>();
  private closed = false;
  private readonly defaultWorkerPermissions: readonly PermissionSettings[];
  private readonly evicted = (row: WorkerRow) => this.emit({ ...this.identity(row), kind: "worker_stopped", reason: "eviction" });

  constructor(
    private readonly workers: WorkerPersistence,
    private readonly conversations: AgentConversationManager,
    private readonly options: OrchestratorConfig["workers"] & { readonly defaultPermissions?: PermissionSettings },
    private readonly log: Logger,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly assignments?: WorkerAssignmentPort,
    private readonly findGivingConversation?: FindGivingConversation,
  ) {
    this.pool = new WorkerPool(options.limit, options.idleStopMs ?? 600_000);
    const defaults = ownPermissions(options.defaultPermissions);
    this.defaultWorkerPermissions = defaults ? [defaults] : [];
  }

  open(actor: WorkerActor, input: WorkerInput): Promise<OpenWorkerResult> {
    return this.run(async () => {
      requireWorkerUse(actor);
      this.assertInput(input);
      const rows = await this.workers.list();
      checkWorkerOpenLimit(actor, await this.activeRows(rows));
      if (!await this.pool.makeRoom(this.evicted)) return { status: "no_worker_free", workers: await this.summaries(actor) };
      const ordinal = rows.reduce((highest, row) => /^w[1-9][0-9]*$/.test(row.handle)
        ? Math.max(highest, Number(row.handle.slice(1))) : highest, 0) + 1;
      if (!Number.isSafeInteger(ordinal)) throw new RangeError("worker handle space exhausted");
      const handle = `w${ordinal}`;
      const conversation = await this.conversations.create({ role: "worker", ...this.startOptions() });
      const row: WorkerRow = {
        handle, conversationId: conversation.id, createdAt: new Date().toISOString(),
        openedBy: actor.kind === "consumer" ? "consumer" : actor.conversationId,
        ...(actor.kind === "conversation" ? { lastConversation: actor.conversationId } : {}),
        ...(input.about === undefined ? {} : { about: input.about }),
      };
      try {
        await this.workers.create(row);
      } catch (error) {
        try {
          await this.conversations.delete(conversation.id);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "worker registration and conversation cleanup failed");
        }
        throw error;
      }
      const slot = this.pool.attach(row, conversation);
      this.emit({ ...this.identity(row), kind: "worker_opened" });
      this.dispatch(slot, actor, input.text, planAssignment(actor, input)!);
      return { status: "sent", handle };
    });
  }

  send(actor: WorkerActor, handle: string, input: SendWorkerInput): Promise<SendWorkerResult> {
    return this.run(async () => {
      requireWorkerUse(actor);
      this.assertInput(input);
      const row = await this.requireWorker(actor, handle);
      let slot = this.pool.get(handle);
      const running = slot?.work?.assignment;
      const plan = planAssignment(actor, input, running);
      if (!plan || (slot && this.pool.busy(slot) && !running)) return { status: "busy", worker: await this.summary(row) };
      if (running && running.destination !== plan.assignment.destination) requireWorkerRedirect(actor);
      if (!slot) {
        if (!await this.pool.makeRoom(this.evicted)) return { status: "no_worker_free", workers: await this.summaries(actor) };
        const { conversation } = await this.conversations.open(row.conversationId, this.startOptions());
        slot = this.pool.attach(row, conversation);
        this.emit({ ...this.identity(row), kind: "worker_reloaded" });
      }
      const change = {
        ...(input.about === undefined ? {} : { about: input.about }),
        ...(actor.kind === "conversation" ? { lastConversation: actor.conversationId } : {}),
      };
      const workerSlot = slot;
      const update = async () => {
        if (!await this.workers.update(handle, change)) throw new Error(`worker is unavailable: ${handle}`);
        workerSlot.row = { ...workerSlot.row, ...change };
      };
      const redirected = running && running.destination !== plan.assignment.destination;
      if (!redirected) await update();
      this.dispatch(slot, actor, input.text, plan, redirected ? async () => {
        await update();
        const event = { ...this.identity(workerSlot.row), kind: "worker_redirected" as const,
          ...(running.destination ? { previousConversation: running.destination } : {}) };
        return () => this.emit(event);
      } : undefined);
      return { status: running ? "steered" : "sent" };
    });
  }

  check(actor: WorkerActor, handle: string): Promise<WorkerSummary> {
    return this.run(async () => {
      return this.summary(await this.requireWorker(actor, handle));
    });
  }

  list(actor: WorkerActor): Promise<readonly WorkerSummary[]> {
    return this.run(async () => {
      return this.summaries(actor);
    });
  }

  stop(actor: WorkerActor, handle: string): Promise<"stopped" | "idle"> {
    return this.run(async () => {
      const row = await this.requireWorker(actor, handle);
      const running = this.pool.get(handle)?.work;
      if (actor.kind === "conversation" && running && running.assignment.destination !== actor.conversationId) {
        requireWorkerRedirect(actor);
      }
      if (!await this.interrupt(handle)) return "idle";
      this.emit({ ...this.identity(row), kind: "worker_stopped", reason: "requested" });
      return "stopped";
    });
  }

  drop(actor: WorkerActor, handle: string): Promise<DeleteConversationResult> {
    return this.run(async () => {
      requireWorkerRedirect(actor);
      const row = await this.requireWorker(actor, handle, true);
      if (!await this.reconcileWorker(row)) return { providerDeleted: false, checkpointsDeleted: 0 };
      await this.interrupt(handle);
      let result: DeleteConversationResult;
      try {
        result = await this.conversations.delete(row.conversationId, { providerSession: "best-effort" });
      } catch (error) {
        if ((await this.conversations.get(row.conversationId))?.deletedAt) await this.markDropped(row);
        throw error;
      }
      await this.markDropped(row);
      return result;
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.pool.closeIdleTimers();
    return this.pool.run(async () => {});
  }

  async waitForCompletions(): Promise<void> { await Promise.allSettled(this.completions); }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("orchestrator is closed"));
    return this.pool.run(work);
  }

  private async markDropped(row: WorkerRow): Promise<void> {
    const dropped = await this.workers.drop(row.handle, new Date().toISOString());
    try {
      await this.pool.release(row.handle);
    } finally {
      if (dropped) this.emit({ ...this.identity(row), kind: "worker_dropped" });
    }
  }

  private async interrupt(handle: string): Promise<boolean> {
    const slot = this.pool.get(handle);
    if (!slot || !this.pool.busy(slot)) return false;
    slot.conversation.interrupt({ clearQueue: true });
    await Promise.allSettled(slot.completions);
    return true;
  }

  private identity({ handle, conversationId, openedBy, lastConversation }: WorkerRow) {
    return { handle, conversationId, openedBy, ...(lastConversation ? { lastConversation } : {}) };
  }

  private startOptions() {
    const { adapterId, cwd } = this.options;
    return {
      adapterId,
      runtime: {
        ...(cwd === undefined ? {} : { cwd }),
        permissions: { default: "ask" as const },
        // The delegated actor owns the worker's decision. Always enter its prompt handler.
        permissionRule: () => "ask" as const,
      },
    };
  }

  private assertInput(input: WorkerInput): void {
    if (!input.text.trim()) throw new Error("worker prompt cannot be blank");
  }

  private async requireWorker(actor: WorkerActor, handle: string, allowMissingConversation = false): Promise<WorkerRow> {
    const row = await this.workers.get(handle);
    if (actor.kind === "conversation" && actor.policy.scope === "none" &&
      (!row || !canSeeWorker(actor, row, this.pool.get(handle)?.work?.assignment))) throw new WorkerPolicyError("scope");
    if (!row || row.droppedAt) throw new Error(`unknown active worker: ${handle}`);
    if (!allowMissingConversation && !await this.reconcileWorker(row)) throw new Error(`worker conversation is unavailable: ${handle}`);
    return row;
  }

  private async summaries(actor: WorkerActor): Promise<readonly WorkerSummary[]> {
    const visible = (await this.activeRows(await this.workers.list()))
      .filter(row => canSeeWorker(actor, row, this.pool.get(row.handle)?.work?.assignment));
    return Promise.all(visible.map(row => this.summary(row)));
  }

  private async summary(row: WorkerRow): Promise<WorkerSummary> {
    const latest = await this.assignments?.latestOutcome?.(row);
    return { ...this.pool.summary(row), ...(latest ? { latestOutcome: latest.outcome } : {}) };
  }

  private async activeRows(rows: readonly WorkerRow[]): Promise<WorkerRow[]> {
    const active: WorkerRow[] = [];
    for (const row of rows) {
      if (!row.droppedAt && await this.reconcileWorker(row)) active.push(row);
    }
    return active;
  }

  private async reconcileWorker(row: WorkerRow): Promise<boolean> {
    const summary = await this.conversations.get(row.conversationId);
    if (summary && !summary.deletedAt) return true;
    await this.markDropped(row);
    return false;
  }

  private dispatch(
    slot: ReturnType<WorkerPool["attach"]>, actor: WorkerActor, text: string, plan: AssignmentPlan,
    accepted?: () => Promise<() => void>,
  ): void {
    const sender = actor.kind === "conversation" ? actor.sender : undefined;
    const active = this.pool.start(slot, plan.assignment, sender);
    const row = slot.row;
    const identity = this.identity(row);
    if (plan.kind === "start") this.emit({ ...identity, kind: "worker_busy" });
    const policyNames = actor.kind === "conversation" ? [...actor.policyNames] : [];
    let crossedDispatch = false;
    let announceRedirect: (() => void) | undefined;
    const confirmDispatch = () => {
      const announce = announceRedirect;
      announceRedirect = undefined;
      announce?.();
    };
    const input = {
      text,
      handlers: {
        onPermissionRequest: workerPermissionHandler(actor, row, this.findGivingConversation, this.defaultWorkerPermissions),
        ...(accepted ? { onUpdate: confirmDispatch } : {}),
      },
      delivery: plan.kind === "start" ? "queue" as const : "steer" as const,
      ...(actor.kind === "conversation" || accepted ? { beforeDispatch: async (messageId: string) => {
        await this.assignments?.beforeDispatch(row, plan, messageId, policyNames, actor.kind === "conversation" ? actor : undefined);
        crossedDispatch = true;
        // Reservation and retarget have committed. Bookkeeping errors must not refuse that accepted dispatch.
        try { announceRedirect = await accepted?.(); }
        catch (error) { this.log.warn("worker_dispatch_bookkeeping_failed", { handle: row.handle, error: String(error) }); }
      } } : {}),
    };
    const work = sender === undefined ? slot.conversation.prompt(input) : slot.conversation.promptFrom({ ...input, participantId: sender });
    const completion = work.then(result => {
      if (result.status === "completed") {
        confirmDispatch();
        this.emit({ ...identity, kind: "worker_replied" });
      } else if (result.status === "error") this.emit({ ...identity, kind: "worker_failed", reason: workerTerminalFailure(false).reason });
    }, async (error: unknown) => {
      this.log.warn("worker_prompt_failed", { conversationId: slot.conversation.id, error: String(error) });
      if (!crossedDispatch && plan.kind !== "start" && actor.kind === "conversation") {
        const cause = error instanceof WorkerAssignmentConflict ? "conflict" : "hook_error";
        this.emit({ ...identity, kind: "worker_failed", reason: "refused", cause, destination: actor.conversationId });
        try { await this.assignments?.refuse?.(row, plan, { actor, cause }); }
        catch (failure) { this.log.warn("worker_refusal_persistence_failed", { handle: row.handle, error: String(failure) }); }
        return;
      }
      this.emit({ ...identity, kind: "worker_failed", reason: workerTerminalFailure(false, error).reason });
    }).finally(() => {
      slot.completions.delete(completion);
      this.pool.finish(slot, active);
      const touched = slot.touched;
      const idle = () => {
        if (slot.touched !== touched || this.pool.get(row.handle) !== slot || this.pool.busy(slot)) return;
        this.emit({ ...this.identity(slot.row), kind: "worker_idle" });
        this.pool.armIdle(slot, row => this.emit({ ...this.identity(row), kind: "worker_stopped", reason: "idle" }),
          error => this.log.warn("worker_idle_stop_failed", { handle: slot.row.handle, error: String(error) }));
      };
      const flush = actor.kind === "conversation" && this.assignments?.settled?.();
      if (flush) return flush.finally(idle);
      idle();
    });
    slot.completions.add(completion);
    this.completions.add(completion);
    const forget = () => { this.completions.delete(completion); };
    void completion.then(forget, forget);
  }
}
