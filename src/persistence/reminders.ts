import type { ReminderExpiry, ReminderExpiryPolicy, ReminderSchedule } from "../native/reminders/schedule.ts";
import { defaultReminderLimits } from "../native/reminders/limits.ts";
import { compareReminderDeadline, deriveReminderWake, type ReminderDeadline, type ReminderDeadlineDecision } from "./reminder-wake.ts";

export interface Reminder {
  readonly id: string;
  readonly conversationId: string;
  readonly text: string;
  readonly schedule: ReminderSchedule;
  readonly expiryPolicy: ReminderExpiryPolicy;
  readonly expiry: ReminderExpiry;
  readonly status: "active" | "paused" | "cancelled" | "completed" | "expired";
  readonly policyNames?: readonly string[];
  readonly nextRunAt?: number | null;
  readonly lastRunAt?: number;
  readonly revision?: number;
}

export interface ReminderChangeInput {
  readonly reminder: Reminder;
  readonly acceptedAt: number;
  readonly op: "create" | "update" | "cancel";
  readonly fields?: readonly ("text" | "schedule" | "expiry" | "status" | "policyNames")[];
}

export interface ReminderChange extends ReminderChangeInput {
  readonly changeId: number;
  readonly state: "pending" | "maybe_sent" | "applied" | "blocked";
  readonly reason?: string;
}

export interface ReminderJournal {
  readonly id: string;
  readonly conversationId: string;
  readonly highWater: number;
  readonly confirmed?: Reminder;
  readonly changes: readonly ReminderChange[];
}

export interface ReminderWakeIndex {
  readonly reported: ReminderDeadline | null;
  readonly effectiveAt: number | null;
}

export interface ReminderStorage {
  get(id: string): ReminderJournal | undefined;
  list(): ReminderJournal[];
  save(journal: ReminderJournal): void;
  remove(id: string): void;
  suspended(conversationId: string): boolean;
  setSuspended(conversationId: string, suspended: boolean): void;
  wake(): ReminderWakeIndex;
  saveWake(wake: ReminderWakeIndex): void;
}

type Runner = <T>(operation: () => T) => Promise<T>;

export interface ReminderPersistence {
  readonly durable: boolean;
  list(): Promise<readonly ReminderJournal[]>;
  wake(): Promise<ReminderWakeIndex>;
  updateDeadline(deadline: ReminderDeadline, replaceSession?: boolean): Promise<ReminderDeadlineDecision>;
  setConversationSuspended(conversationId: string, suspended: boolean): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  enqueue(change: ReminderChangeInput): Promise<ReminderChange | undefined>;
  markMaybeSent(id: string, changeId: number): Promise<ReminderChange | undefined>;
  acknowledge(id: string, changeId: number, outcome: { confirmed: Reminder } | { reason: string }): Promise<boolean>;
  discardBlocked(id: string): Promise<void>;
}

export class StoredReminderPersistence implements ReminderPersistence {
  constructor(
    readonly durable: boolean,
    private readonly store: ReminderStorage,
    private readonly write: Runner,
    private readonly read: Runner,
  ) {}

  list(): Promise<readonly ReminderJournal[]> {
    return this.read(() => this.store.list());
  }

  wake(): Promise<ReminderWakeIndex> {
    return this.read(() => this.store.wake());
  }

  private recompute(reported = this.store.wake().reported): void {
    const candidates = this.store.list().flatMap((journal) => journal.changes.map((change) => {
      const latest = journal.changes.at(-1)?.reminder ?? change.reminder;
      const { schedule } = change.reminder;
      return {
        ...change,
        dueAt: "at" in schedule ? schedule.at : "startAt" in schedule ? schedule.startAt : null,
        paused: latest.status === "paused" || change.reminder.status === "paused",
        suspended: this.store.suspended(journal.conversationId),
        retiring: false,
      };
    }));
    this.store.saveWake({
      reported,
      effectiveAt: deriveReminderWake(reported, candidates, defaultReminderLimits.oneShotLeadMs),
    });
  }

  updateDeadline(deadline: ReminderDeadline, replaceSession = false): Promise<ReminderDeadlineDecision> {
    return this.write(() => {
      const result = compareReminderDeadline(this.store.wake().reported, deadline, replaceSession);
      if (result === "accepted") this.recompute(deadline);
      return result;
    });
  }

  setConversationSuspended(conversationId: string, suspended: boolean): Promise<void> {
    return this.write(() => {
      this.store.setSuspended(conversationId, suspended);
      this.recompute();
    });
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.write(() => {
      for (const journal of this.store.list()) {
        if (journal.conversationId === conversationId) this.store.remove(journal.id);
      }
      this.store.setSuspended(conversationId, false);
      this.recompute();
    });
  }

  enqueue(input: ReminderChangeInput): Promise<ReminderChange | undefined> {
    const change = structuredClone(input);
    const { id, conversationId } = change.reminder;
    return this.write(() => {
      const journal = this.store.get(id) ?? { id, conversationId, highWater: 0, changes: [] };
      if (journal.conversationId !== conversationId) throw new Error("Reminder belongs to another conversation");
      const latest = journal.changes.at(-1);
      const coalesce = latest?.state === "pending";
      const changes = coalesce ? journal.changes.slice(0, -1) : [...journal.changes];
      const changeId = journal.highWater + 1;
      const next: ReminderChange | undefined = coalesce && latest.op === "create" && change.op === "cancel"
        ? undefined
        : { ...change, op: coalesce && latest.op === "create" ? "create" : change.op, changeId, state: "pending" };
      const queued = next && coalesce && latest.fields && next.fields && next.op === "update"
        ? { ...next, fields: [...new Set([...latest.fields, ...next.fields])] }
        : next;
      if (queued) changes.push(queued);
      this.store.save({ ...journal, highWater: changeId, changes });
      this.recompute();
      return structuredClone(queued);
    });
  }

  markMaybeSent(id: string, changeId: number): Promise<ReminderChange | undefined> {
    return this.write(() => {
      const journal = this.store.get(id);
      const entry = journal?.changes.find((change) => change.changeId === changeId);
      if (!journal || !entry || (entry.state !== "pending" && entry.state !== "maybe_sent")) return;
      const next: ReminderChange = { ...entry, state: "maybe_sent" };
      this.store.save({ ...journal, changes: journal.changes.map((change) => change === entry ? next : change) });
      return structuredClone(next);
    });
  }

  acknowledge(
    id: string,
    changeId: number,
    outcome: { confirmed: Reminder } | { reason: string },
  ): Promise<boolean> {
    const receipt = structuredClone(outcome);
    return this.write(() => {
      const journal = this.store.get(id);
      const sent = journal?.changes.filter((change) => change.state !== "pending");
      const entry = sent?.find((change) => change.changeId === changeId);
      if (!journal || entry?.state !== "maybe_sent") return false;
      if ("reason" in receipt) {
        this.store.save({
          ...journal,
          changes: journal.changes.map((change) => change === entry
            ? { ...change, state: "blocked", reason: receipt.reason }
            : change),
        });
      } else {
        const confirmed = journal.confirmed;
        const newer = !confirmed || (receipt.confirmed.revision ?? 0) >= (confirmed.revision ?? 0);
        this.store.save({
          ...journal,
          confirmed: newer ? receipt.confirmed : confirmed,
          changes: sent?.at(-1) === entry
            ? journal.changes.filter((change) => change.changeId > changeId)
            : journal.changes.map((change) => change === entry ? { ...change, state: "applied" } : change),
        });
      }
      this.recompute();
      return true;
    });
  }

  discardBlocked(id: string): Promise<void> {
    return this.write(() => {
      const journal = this.store.get(id);
      if (!journal) return;
      this.store.save({ ...journal, changes: journal.changes.filter((change) => change.state !== "blocked") });
      this.recompute();
    });
  }
}

export function createMemoryReminderPersistence(): ReminderPersistence {
  const journals = new Map<string, ReminderJournal>();
  const suspended = new Set<string>();
  let wake: ReminderWakeIndex = { reported: null, effectiveAt: null };
  const run: Runner = async (operation) => operation();
  return new StoredReminderPersistence(false, {
    get: (id) => structuredClone(journals.get(id)),
    list: () => structuredClone([...journals.values()]),
    save: (journal) => { journals.set(journal.id, structuredClone(journal)); },
    remove: (id) => { journals.delete(id); },
    suspended: (id) => suspended.has(id),
    setSuspended: (id, value) => { if (value) suspended.add(id); else suspended.delete(id); },
    wake: () => structuredClone(wake),
    saveWake: (value) => { wake = structuredClone(value); },
  }, run, run);
}
