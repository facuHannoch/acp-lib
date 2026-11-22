import { checkWorkerOpenLimit, requireWorkerRedirect, requireWorkerScope, requireWorkerUse } from "./policy.ts";
import type { AssignmentPlan, WorkerAssignmentPort } from "./assignments.ts";
import { planAssignment } from "./busy.ts";
import type { AgentConversationManager } from "../agent/config.ts";
import { workerTerminalFailure } from "../persistence/worker-terminal-reason.ts";
import type { Logger } from "../logger.ts";
import type { WorkerPersistence, WorkerRow } from "../persistence/workers.ts";
import type { OrchestratorConfig } from "./config.ts";
import type { OpenWorkerResult, SendWorkerInput, SendWorkerResult, WorkerActor, WorkerEvent, WorkerInput, WorkerSummary } from "./contracts.ts";
import { WorkerPool } from "./pool.ts";

export class Orchestrator {
  private readonly pool: WorkerPool;
  private closed = false;
  private readonly evicted = (row: WorkerRow) => this.emit({ ...this.identity(row), kind: "worker_stopped", reason: "eviction" });

  constructor(
    private readonly workers: WorkerPersistence,
    private readonly conversations: AgentConversationManager,
    private readonly options: OrchestratorConfig["workers"],
    private readonly log: Logger,
    private readonly emit: (event: WorkerEvent) => void,
    private readonly assignments?: WorkerAssignmentPort,
  ) {
    this.pool = new WorkerPool(options.limit);
  }

  open(actor: WorkerActor, input: WorkerInput): Promise<OpenWorkerResult> {
    return this.run(async () => {
      requireWorkerUse(actor);
      this.assertInput(input);
      const rows = await this.workers.list();
      checkWorkerOpenLimit(actor, rows);
      if (!await this.pool.makeRoom(this.evicted)) return { status: "no_worker_free", workers: await this.summaries() };
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
      const row = await this.requireWorker(handle);
      let slot = this.pool.get(handle);
      const running = slot?.work?.assignment;
      const plan = planAssignment(actor, input, running);
      if (!plan || (slot && this.pool.busy(slot) && !running)) return { status: "busy", worker: this.pool.summary(row) };
      if (running && input.redirect) requireWorkerRedirect(actor);
      if (!slot) {
        const summary = await this.conversations.get(row.conversationId);
        if (!summary || summary.deletedAt) throw new Error(`worker conversation is unavailable: ${handle}`);
        if (!await this.pool.makeRoom(this.evicted)) return { status: "no_worker_free", workers: await this.summaries() };
        const { conversation } = await this.conversations.open(row.conversationId, this.startOptions());
        slot = this.pool.attach(row, conversation);
        this.emit({ ...this.identity(row), kind: "worker_reloaded" });
      }
      const change = {
        ...(input.about === undefined ? {} : { about: input.about }),
        ...(actor.kind === "conversation" ? { lastConversation: actor.conversationId } : {}),
      };
      if (!await this.workers.update(handle, change)) throw new Error(`worker is unavailable: ${handle}`);
      slot.row = { ...row, ...change };
      if (running && running.destination !== plan.assignment.destination) {
        this.emit({ ...this.identity(slot.row), kind: "worker_redirected",
          ...(running.destination ? { previousConversation: running.destination } : {}) });
      }
      this.dispatch(slot, actor, input.text, plan);
      return { status: running ? "steered" : "sent" };
    });
  }

  check(actor: WorkerActor, handle: string): Promise<WorkerSummary> {
    return this.run(async () => {
      requireWorkerScope(actor);
      return this.pool.summary(await this.requireWorker(handle));
    });
  }

  list(actor: WorkerActor): Promise<readonly WorkerSummary[]> {
    return this.run(async () => {
      requireWorkerScope(actor);
      return this.summaries();
    });
  }

  stop(actor: WorkerActor, handle: string): Promise<void> {
    return this.run(async () => {
      requireWorkerScope(actor);
      const row = await this.requireWorker(handle);
      const running = this.pool.get(handle)?.work;
      if (actor.kind === "conversation" && running && running.assignment.destination !== actor.conversationId) {
        requireWorkerRedirect(actor);
      }
      if (await this.interrupt(handle)) this.emit({ ...this.identity(row), kind: "worker_stopped", reason: "requested" });
    });
  }

  drop(actor: WorkerActor, handle: string): Promise<void> {
    return this.run(async () => {
      requireWorkerScope(actor);
      requireWorkerRedirect(actor);
      const row = await this.requireWorker(handle);
      await this.interrupt(handle);
      try {
        await this.conversations.delete(row.conversationId);
      } catch (error) {
        if ((await this.conversations.get(row.conversationId))?.deletedAt) await this.markDropped(row);
        throw error;
      }
      await this.markDropped(row);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.pool.run(async () => {});
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("orchestrator is closed"));
    return this.pool.run(work);
  }

  private async markDropped(row: WorkerRow): Promise<void> {
    if (!await this.workers.drop(row.handle, new Date().toISOString())) return;
    this.emit({ ...this.identity(row), kind: "worker_dropped" });
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
    return { adapterId, ...(cwd === undefined ? {} : { runtime: { cwd } }) };
  }

  private assertInput(input: WorkerInput): void {
    if (!input.text.trim()) throw new Error("worker prompt cannot be blank");
  }

  private async requireWorker(handle: string): Promise<WorkerRow> {
    const row = await this.workers.get(handle);
    if (!row || row.droppedAt) throw new Error(`unknown active worker: ${handle}`);
    return row;
  }

  private async summaries(): Promise<readonly WorkerSummary[]> {
    return (await this.workers.list()).filter(row => !row.droppedAt).map(row => this.pool.summary(row));
  }

  private dispatch(slot: ReturnType<WorkerPool["attach"]>, actor: WorkerActor, text: string, plan: AssignmentPlan): void {
    const sender = actor.kind === "conversation" ? actor.sender : undefined;
    const active = this.pool.start(slot, plan.assignment, sender);
    const row = slot.row;
    const identity = this.identity(row);
    if (plan.kind === "start") this.emit({ ...identity, kind: "worker_busy" });
    const input = {
      text,
      delivery: plan.kind === "start" ? "queue" as const : "steer" as const,
      ...(this.assignments ? { beforeDispatch: (messageId: string) => this.assignments!.beforeDispatch(row, plan, messageId) } : {}),
    };
    const work = sender === undefined ? slot.conversation.prompt(input) : slot.conversation.promptFrom({ ...input, participantId: sender });
    const completion = work.then(result => {
      if (result.status === "completed") this.emit({ ...identity, kind: "worker_replied" });
      else if (result.status === "error") this.emit({ ...identity, kind: "worker_failed", reason: workerTerminalFailure(false).reason });
    }, (error: unknown) => {
      this.log.warn("worker_prompt_failed", { conversationId: slot.conversation.id, error: String(error) });
      this.emit({ ...identity, kind: "worker_failed", reason: workerTerminalFailure(false, error).reason });
    }).finally(() => {
      slot.completions.delete(completion);
      if (this.pool.finish(slot, active) && slot.conversation.state.phase !== "stopped") this.emit({ ...identity, kind: "worker_idle" });
    });
    slot.completions.add(completion);
    void completion.catch(() => undefined);
  }
}
