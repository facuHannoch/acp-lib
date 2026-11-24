import { randomUUID } from "node:crypto";
import type { PersistenceBackend } from "../../persistence/backend.ts";
import { createMemoryReminderPersistence, type Reminder, type ReminderChange, type ReminderJournal, type ReminderPersistence } from "../../persistence/reminders.ts";
import { defaultReminderLimits, type ReminderLimits } from "./limits.ts";
import { normalizeReminderSchedule, ReminderError, reminderExpiryPolicy, resolveReminderExpiry, type ReminderScheduleInput } from "./schedule.ts";

export interface ReminderEdit {
  readonly text?: string;
  readonly schedule?: ReminderScheduleInput;
  readonly expiresAfter?: number | null;
  readonly policyNames?: readonly string[];
}

export interface ReminderCreate extends ReminderEdit {
  readonly text: string;
  readonly schedule: ReminderScheduleInput;
}

export interface ReminderView extends Reminder {
  readonly state: "pending" | "maybe_sent" | "confirmed" | "blocked";
  readonly reason?: string;
}

export type ReminderEvent = {
  kind: "reminder_created" | "reminder_changed" | "reminder_confirmed" | "reminder_blocked" | "reminder_cancelled";
  reminder: ReminderView;
};

export interface ReminderServiceOptions {
  readonly persistence?: PersistenceBackend;
  readonly repository?: ReminderPersistence;
  readonly running?: () => boolean;
  readonly now?: () => number;
  readonly limits?: ReminderLimits;
  readonly authorize?: (conversationId: string, op: ReminderChange["op"]) => boolean;
  readonly live?: (change: ReturnType<typeof reminderRequest>) => Promise<{ confirmed: Reminder } | { reason: string }>;
}

export function reminderRequest(change: ReminderChange) {
  const { id, conversationId, text, schedule, expiry, status, policyNames } = change.reminder;
  const includes = (field: NonNullable<ReminderChange["fields"]>[number]) =>
    change.op === "create" || (change.op === "update" && (change.fields?.includes(field) ?? true));
  return {
    reminderId: id,
    changeId: change.changeId,
    op: change.op,
    payload: {
      conversationId, acceptedAt: change.acceptedAt, attribution: "host",
      ...(includes("text") ? { text } : {}),
      ...(includes("schedule") ? { schedule } : {}),
      ...(includes("status") ? { status } : {}),
      ...(policyNames === undefined || !includes("policyNames") ? {} : { policyNames }),
      ...(!includes("expiry") || expiry?.kind === "harness_default" ? {} : { expiresAfter: expiry?.kind === "duration" ? expiry.milliseconds : expiry }),
    },
  };
}

function view(journal: ReminderJournal): ReminderView | undefined {
  const change = journal.changes.findLast(({ state }) => state !== "applied");
  if (change && (change.op !== "cancel" || change.state === "blocked")) {
    return { ...change.reminder, state: change.state as Exclude<ReminderView["state"], "confirmed">,
      ...(change.reason === undefined ? {} : { reason: change.reason }) };
  }
  if (!change && journal.confirmed) return { ...journal.confirmed, state: "confirmed" };
}

export class ReminderService {
  private readonly repository: ReminderPersistence;
  private readonly limits: ReminderLimits;

  constructor(private readonly options: ReminderServiceOptions = {}) {
    this.repository = options.persistence?.reminders ?? options.repository ?? createMemoryReminderPersistence();
    this.limits = options.limits ?? defaultReminderLimits;
  }

  private transact<T>(work: (repository: ReminderPersistence) => Promise<T>): Promise<T> {
    const persistence = this.options.persistence;
    return persistence?.reminders
      ? persistence.transaction((scope) => work(scope.reminders!))
      : work(this.repository);
  }

  async list({ after, limit = 50 }: { after?: string; limit?: number } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReminderError("invalid_input", "Page size must be 1–100");
    const rows = (await this.repository.list()).flatMap((journal) => view(journal) ?? []);
    const items = rows.filter(({ id }) => after === undefined || id > after).sort((a, b) => a.id < b.id ? -1 : 1);
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.id : null };
  }

  conversation(conversationId: string, supported: boolean, emit: (event: ReminderEvent) => void) {
    const check = () => {
      if (!supported) throw new ReminderError("reminders_unsupported", "This conversation does not support reminders");
    };
    const authorize = (op: ReminderChange["op"]) => {
      if (this.options.authorize?.(conversationId, op) === false) {
        throw new ReminderError("unauthorized", "Reminder change is not authorized");
      }
    };
    const list = async () => {
      check();
      return (await this.repository.list()).filter((row) => row.conversationId === conversationId)
        .flatMap((journal) => view(journal) ?? []);
    };
    const mutate = async (op: ReminderChange["op"], id: string, edit: ReminderEdit = {}, status?: Reminder["status"]) => {
      check();
      authorize(op);
      const live = this.options.running?.() ? this.options.live : undefined;
      if (!live && !this.repository.durable) {
        throw new ReminderError("reminders_unavailable", "Reminders require a live service or durable persistence");
      }
      const acceptedAt = (this.options.now ?? Date.now)();
      const prepared = await this.transact(async (repo) => {
        const rows = (await repo.list()).filter((row) => row.conversationId === conversationId);
        const previous = rows.find((row) => row.id === id);
        const existing = previous && view(previous);
        if (op !== "create" && !existing) throw new ReminderError("not_found", "Reminder was not found");
        const schedule = edit.schedule
          ? normalizeReminderSchedule(edit.schedule, acceptedAt, this.limits)
          : existing!.schedule;
        const expiryPolicy = edit.expiresAfter !== undefined || !existing
          ? reminderExpiryPolicy(edit.expiresAfter) : existing.expiryPolicy;
        const expiry = edit.schedule || edit.expiresAfter !== undefined
          ? resolveReminderExpiry(schedule, expiryPolicy, acceptedAt, this.limits) : existing!.expiry;
        const text = edit.text ?? existing!.text;
        if (!text.trim()) throw new ReminderError("invalid_input", "Reminder text is required");
        const policyNames = edit.policyNames ?? existing?.policyNames;
        const reminder: Reminder = {
          id, conversationId, text, schedule, expiry, expiryPolicy,
          status: status ?? existing?.status ?? "active",
          ...(policyNames === undefined ? {} : { policyNames }),
        };
        if (op === "create" && rows.filter((row) => {
          const item = view(row);
          return item?.status === "active" || item?.status === "paused";
        }).length >= this.limits.perChannel) {
          throw new ReminderError("limit_exceeded", "Too many reminders for this channel");
        }
        const fields: NonNullable<ReminderChange["fields"]>[number][] = [];
        if (edit.text !== undefined) fields.push("text");
        if (edit.schedule !== undefined) fields.push("schedule");
        if (edit.schedule !== undefined || edit.expiresAfter !== undefined) fields.push("expiry");
        if (status !== undefined) fields.push("status");
        if (edit.policyNames !== undefined) fields.push("policyNames");
        const pending = await repo.enqueue({ reminder, acceptedAt, op, fields });
        const change = pending && live ? await repo.markMaybeSent(id, pending.changeId) : pending;
        return { reminder, change };
      });
      let result: ReminderView = { ...prepared.reminder, state: prepared.change?.state === "maybe_sent" ? "maybe_sent" : "pending" };
      emit({ kind: op === "create" ? "reminder_created" : op === "cancel" ? "reminder_cancelled" : "reminder_changed", reminder: result });
      if (live && prepared.change) {
        const outcome = await live(reminderRequest(prepared.change));
        await this.repository.acknowledge(id, prepared.change.changeId, outcome);
        result = "reason" in outcome
          ? { ...result, state: "blocked", reason: outcome.reason }
          : { ...outcome.confirmed, state: "confirmed" };
        emit({ kind: result.state === "blocked" ? "reminder_blocked" : "reminder_confirmed", reminder: result });
      }
      return result;
    };
    return {
      create: (input: ReminderCreate) => mutate("create", randomUUID(), input),
      get: async (id: string) => (await list()).find((item) => item.id === id),
      list,
      update: (id: string, input: ReminderEdit) => mutate("update", id, input),
      pause: (id: string) => mutate("update", id, {}, "paused"),
      resume: (id: string) => mutate("update", id, {}, "active"),
      cancel: (id: string) => mutate("cancel", id, {}, "cancelled"),
      discardBlocked: async (id: string) => {
        check();
        authorize("update");
        await this.transact(async (repo) => {
          if ((await repo.list()).some((row) => row.id === id && row.conversationId === conversationId)) {
            await repo.discardBlocked(id);
          }
        });
      },
    };
  }
}
