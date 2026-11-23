import type { RunningAssignment } from "./assignments.ts";
import type { AgentConversation } from "../agent-session.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { WorkerSummary } from "./contracts.ts";

interface Slot {
  readonly conversation: AgentConversation;
  row: WorkerRow;
  readonly completions: Set<Promise<void>>;
  touched: number;
  work?: { readonly started: number; readonly sender?: string; readonly assignment: RunningAssignment };
}

export class WorkerPool {
  private readonly slots = new Map<string, Slot>();
  private tail = Promise.resolve();
  private access = 0;

  constructor(private readonly limit: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  attach(row: WorkerRow, conversation: AgentConversation): Slot {
    const slot: Slot = { row, conversation, touched: ++this.access, completions: new Set() };
    this.slots.set(row.handle, slot);
    return slot;
  }

  get(handle: string): Slot | undefined {
    const slot = this.slots.get(handle);
    return slot?.conversation.state.phase === "stopped" ? undefined : slot;
  }

  async release(handle: string): Promise<void> {
    const slot = this.slots.get(handle);
    if (!slot) return;
    await slot.conversation.stop();
    this.slots.delete(handle);
  }

  async makeRoom(onEvicted: (row: WorkerRow) => void): Promise<boolean> {
    for (const [handle, slot] of this.slots) {
      if (slot.conversation.state.phase !== "stopped") continue;
      await this.release(handle);
    }
    if (this.slots.size < this.limit) return true;
    const oldest = [...this.slots.entries()].filter(([, slot]) => !this.busy(slot))
      .sort(([, left], [, right]) => left.touched - right.touched)[0];
    if (!oldest) return false;
    const [handle, slot] = oldest;
    await this.release(handle);
    onEvicted(slot.row);
    return true;
  }

  busy(slot: Slot): boolean {
    return Boolean(slot.work || slot.conversation.isBusy);
  }

  start(slot: Slot, assignment: RunningAssignment, sender?: string): NonNullable<Slot["work"]> {
    slot.touched = ++this.access;
    const started = slot.work?.started ?? performance.now();
    return slot.work = { started, sender, assignment };
  }

  finish(slot: Slot, work: Slot["work"]): boolean {
    if (slot.work !== work) return false;
    slot.work = undefined;
    slot.touched = ++this.access;
    return true;
  }

  summary(row: WorkerRow): WorkerSummary {
    const slot = this.get(row.handle);
    if (!slot) return { ...row, state: "offline" };
    const operation = slot.conversation.state.operation;
    return {
      ...row,
      state: this.busy(slot) ? "busy" : "idle",
      ...(operation ? { operation } : {}),
      ...(slot.work?.sender === undefined ? {} : { sender: slot.work.sender }),
      ...(slot.work ? { busyMs: Math.max(0, performance.now() - slot.work.started) } : {}),
    };
  }
}
