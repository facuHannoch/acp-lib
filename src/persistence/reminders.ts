import type { WireChange } from "../native/reminders/wire.ts";
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
  readonly status: "active" | "paused" | "cancelled" | "completed" | "expired" | "blocked";
  readonly policyNames?: readonly string[];
  readonly nextRunAt?: number | null;
  readonly lastRunAt?: number;
  readonly revision?: number;
  readonly scheduleAcceptedAt?: number;
  readonly createdBy?: "agent" | "host";
  readonly creatorId?: string;
  readonly lastOccurrenceId?: string;
  readonly noticeId?: string;
  readonly blockedReason?: string;
  readonly unreconciled?: boolean;
  readonly missing?: boolean;
}

export interface ReminderChangeInput {
  readonly reminder: Reminder;
  readonly acceptedAt: number;
  readonly op: "create" | "update" | "cancel";
  readonly fields?: readonly ("text" | "schedule" | "expiry" | "status" | "policyNames")[];
}

export interface ReminderChange extends ReminderChangeInput {
  readonly changeId: number;
  readonly stagingOrder: number;
  readonly observedAtSend?: number;
  readonly frozenWire?: WireChange;
  readonly state: "pending" | "maybe_sent" | "applied" | "blocked";
  readonly reason?: string;
}

export interface ReminderJournal {
  readonly id: string;
  readonly conversationId: string;
  readonly highWater: number;
  readonly confirmed?: Reminder;
  readonly observation?: number;
  readonly receiptVersion?: number;
  readonly changes: readonly ReminderChange[];
}

export interface ReminderWakeIndex {
  readonly reported: ReminderDeadline | null;
  readonly effectiveAt: number | null;
  readonly supported?: boolean;
}

export interface ReminderStorage {
  nextOrder(): number;
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
  markMaybeSent(id: string, changeId: number, wire?: WireChange): Promise<ReminderChange | undefined>;
  acknowledge(id: string, changeId: number, outcome: { confirmed: Reminder } | { reason: string }): Promise<boolean>;
  discardBlocked(id: string): Promise<void>;
  observe(reminder: Reminder): Promise<void>;
  restoreStaged(change: ReminderChange): Promise<void>;
  quarantine(id: string, changeId: number, reason: string): Promise<void>;
  setSupported(supported: boolean): Promise<void>;
  replaceSession(sessionId: string): Promise<void>;
  completeSweep(seen: ReadonlySet<string>): Promise<void>;
}

function isWakeSchedule(schedule: ReminderSchedule): boolean {
  return !!schedule && "at" in schedule && Number.isSafeInteger(schedule.at);
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
    const supported = this.store.wake().supported;
    const candidates = supported === false ? [] : this.store.list().flatMap((journal) => journal.changes.filter(change => isWakeSchedule(change.reminder.schedule)).map((change) => {
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
      ...(supported === undefined ? {} : { supported }),
      effectiveAt: supported === false ? null : deriveReminderWake(reported, candidates, defaultReminderLimits.oneShotLeadMs),
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
      const coalesce = latest?.state === "pending" && !latest.frozenWire && !(latest.op === "create" && change.reminder.status === "paused");
      const dropCreate = change.op === "cancel" && journal.changes[0]?.op === "create"
        && journal.changes.every(entry => entry.state === "pending");
      const changes = dropCreate ? [] : coalesce ? journal.changes.slice(0, -1) : [...journal.changes];
      const changeId = journal.highWater + 1;
      const next: ReminderChange | undefined = dropCreate
        ? undefined
        : { ...change, op: coalesce && latest.op === "create" ? "create" : change.op, changeId, stagingOrder: coalesce ? latest.stagingOrder : this.store.nextOrder(), state: "pending" };
      const queued = next && coalesce && latest.fields && next.fields && next.op === "update"
        ? { ...next, fields: [...new Set([...latest.fields, ...next.fields])] }
        : next;
      if (queued) changes.push(queued);
      this.store.save({ ...journal, highWater: changeId, changes });
      this.recompute();
      return structuredClone(queued);
    });
  }

  markMaybeSent(id: string, changeId: number, wire?: WireChange): Promise<ReminderChange | undefined> {
    return this.write(() => {
      const journal = this.store.get(id);
      const entry = journal?.changes.find((change) => change.changeId === changeId);
      if (!journal || !entry || (entry.state !== "pending" && entry.state !== "maybe_sent")) return;
      if (entry.state === "maybe_sent" && (!wire || entry.frozenWire)) return structuredClone(entry);
      const next: ReminderChange = { ...entry, state: "maybe_sent", observedAtSend: entry.observedAtSend ?? journal.observation ?? 0, frozenWire: wire ?? entry.frozenWire };
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
        const newer = !confirmed || ((journal.observation ?? 0) === entry.observedAtSend
          && changeId >= (journal.receiptVersion ?? 0));
        this.store.save({
          ...journal,
          confirmed: newer ? receipt.confirmed : confirmed,
          receiptVersion: newer ? changeId : journal.receiptVersion,
          changes: sent?.at(-1) === entry
            ? journal.changes.filter((change) => change.changeId > changeId)
            : journal.changes.map((change) => change === entry ? { ...change, state: "applied" } : change),
        });
      }
      this.recompute();
      return true;
    });
  }

  observe(reminder: Reminder): Promise<void> {
    return this.write(() => {
      const current = this.store.get(reminder.id) ?? {
        id: reminder.id, conversationId: reminder.conversationId, highWater: 0, changes: [],
      };
      if (current.conversationId !== reminder.conversationId) return;
      this.store.save({ ...current, observation: (current.observation ?? 0) + 1, confirmed: reminder });
    });
  }

  restoreStaged(original: ReminderChange): Promise<void> {
    return this.write(() => {
      const journal = this.store.get(original.reminder.id);
      if (!journal) return;
      this.store.save({
        ...journal,
        changes: journal.changes.map(change => change.changeId === original.changeId && change.state === "maybe_sent"
          ? original : change),
      });
      this.recompute();
    });
  }

  quarantine(id: string, changeId: number, reason: string): Promise<void> {
    return this.write(() => {
      const journal = this.store.get(id);
      if (!journal) return;
      this.store.save({ ...journal, changes: journal.changes.map(change => change.changeId === changeId
        ? { ...change, state: "blocked", reason } : change) });
      this.recompute();
    });
  }

  setSupported(supported: boolean): Promise<void> {
    return this.write(() => {
      this.store.saveWake({ ...this.store.wake(), supported });
      this.recompute();
    });
  }

  replaceSession(sessionId: string): Promise<void> {
    return this.write(() => {
      for (const row of this.store.list()) {
        this.store.save({
          ...row,
          changes: row.changes.map(change => change.state === "maybe_sent" ? { ...change, state: "pending", observedAtSend: undefined } : change),
          ...(row.confirmed ? { confirmed: { ...row.confirmed, unreconciled: true }, receiptVersion: undefined } : {}),
        });
      }
      this.recompute({ sessionId, revision: 0, nextDueAt: null });
    });
  }

  completeSweep(seen: ReadonlySet<string>): Promise<void> {
    return this.write(() => {
      for (const row of this.store.list()) {
        if (!row.confirmed || seen.has(row.id) || row.changes.some(change => change.state === "pending" || change.state === "maybe_sent")) continue;
        this.store.save({ ...row, confirmed: { ...row.confirmed, unreconciled: false, missing: true } });
      }
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
  let order = 0;
  const journals = new Map<string, ReminderJournal>();
  const suspended = new Set<string>();
  let wake: ReminderWakeIndex = { reported: null, effectiveAt: null };
  const run: Runner = async (operation) => operation();
  return new StoredReminderPersistence(false, {
    nextOrder: () => ++order,
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
