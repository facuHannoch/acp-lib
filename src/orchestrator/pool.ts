import type { AgentConversation } from "../agent-session.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { WorkerSummary } from "./contracts.ts";

interface Slot {
  readonly conversation: AgentConversation;
  touched: number;
  work?: { readonly started: number; readonly sender?: string };
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

  attach(handle: string, conversation: AgentConversation): Slot {
    const slot = { conversation, touched: ++this.access };
    this.slots.set(handle, slot);
    return slot;
  }

  get(handle: string): Slot | undefined {
    const slot = this.slots.get(handle);
    if (slot?.conversation.state.phase === "stopped") {
      this.slots.delete(handle);
      return;
    }
    return slot;
  }

  async makeRoom(): Promise<boolean> {
    for (const handle of this.slots.keys()) this.get(handle);
    if (this.slots.size < this.limit) return true;
    const oldest = [...this.slots.entries()].filter(([, slot]) => !this.busy(slot))
      .sort(([, left], [, right]) => left.touched - right.touched)[0];
    if (!oldest) return false;
    const [handle, slot] = oldest;
    await slot.conversation.stop();
    this.slots.delete(handle);
    return true;
  }

  busy(slot: Slot): boolean {
    return Boolean(slot.work || slot.conversation.isBusy);
  }

  start(slot: Slot, sender?: string): void {
    slot.touched = ++this.access;
    slot.work = { started: performance.now(), sender };
  }

  finish(slot: Slot): void {
    slot.work = undefined;
    slot.touched = ++this.access;
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
