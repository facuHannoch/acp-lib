import { isRoutineSchedule, type MissedRuns, type RoutineOverlap } from "./routine-schedule.ts";
import { SqliteAgentPersistence } from "../../persistence/sqlite-backend.ts";
import { ReminderWakeSupervisor } from "./supervisor.ts";
import { ReminderSync } from "./sync.ts";
import type { NativeHarnessHost } from "../host.ts";
import { noopLogger } from "../../logger.ts";
import { routineReminderRequest as reminderRequest } from "./wire.ts";
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
  readonly missedRuns?: MissedRuns;
  readonly overlap?: RoutineOverlap;
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
  kind: "reminder_intent_recorded" | "reminder_intent_confirmed" | "reminder_intent_blocked" | "reminder_intent_discarded";
  reminder: ReminderView;
};

export type LiveReminderOutcome = { confirmed: Reminder } | { reason: string } | { retryable: true };

export interface ReminderServiceOptions {
  readonly persistence?: PersistenceBackend;
  readonly repository?: ReminderPersistence;
  readonly supported?: () => boolean | undefined;
  readonly routineUnavailable?: () => string | undefined;
  readonly negotiatedLimits?: () => ReminderLimits | undefined;
  readonly refresh?: (channel?: string, id?: string) => Promise<void>;
  readonly running?: () => boolean;
  readonly now?: () => number;
  readonly limits?: ReminderLimits;
  readonly authorize?: (conversationId: string, op: ReminderChange["op"]) => boolean;
  readonly live?: (change: ReturnType<typeof reminderRequest>, original?: ReminderChange) => Promise<LiveReminderOutcome>;
}

export { routineReminderRequest as reminderRequest } from "./wire.ts";

function view(journal: ReminderJournal): ReminderView | undefined {
  const change = journal.changes.findLast(({ state }) => state !== "applied");
  if (change && (change.op !== "cancel" || change.state === "blocked")) {
    return { ...change.reminder, state: change.state as Exclude<ReminderView["state"], "confirmed">,
      ...(change.reason === undefined ? {} : { reason: change.reason }) };
  }
  if (!change && journal.confirmed) return { ...journal.confirmed, state: "confirmed" };
}

export class ReminderService {
  readonly repository: ReminderPersistence;
  private get limits(): ReminderLimits { return this.options.negotiatedLimits?.() ?? this.options.limits ?? defaultReminderLimits; }

  constructor(private readonly options: ReminderServiceOptions = {}) {
    this.repository = options.persistence?.reminders ?? options.repository ?? createMemoryReminderPersistence();
  }

  private transact<T>(work: (repository: ReminderPersistence) => Promise<T>): Promise<T> {
    const persistence = this.options.persistence;
    return persistence?.reminders
      ? persistence.transaction((scope) => work(scope.reminders!))
      : work(this.repository);
  }

  async list({ after, limit = 50 }: { after?: string; limit?: number } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReminderError("invalid_input", "Page size must be 1–100");
    if (this.options.running?.()) await this.options.refresh?.();
    const rows = (await this.repository.list()).flatMap((journal) => view(journal) ?? []);
    const items = rows.filter(({ id }) => after === undefined || id > after).sort((a, b) => a.id < b.id ? -1 : 1);
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.id : null };
  }

  conversation(conversationId: string, supported: boolean, emit: (event: ReminderEvent) => void) {
    const check = () => {
      if (!supported || this.options.supported?.() === false) throw new ReminderError("reminders_unsupported", "This conversation does not support reminders");
    };
    const authorize = (op: ReminderChange["op"]) => {
      if (this.options.authorize?.(conversationId, op) === false) {
        throw new ReminderError("unauthorized", "Reminder change is not authorized");
      }
    };
    const list = async (id?: string) => {
      check();
      if (this.options.running?.()) await this.options.refresh?.(conversationId, id);
      return (await this.repository.list()).filter((row) => row.conversationId === conversationId)
        .flatMap((journal) => view(journal) ?? []);
    };
    const mutate = async (op: ReminderChange["op"], id: string, edit: ReminderEdit = {}, status?: Reminder["status"]) => {
      check();
      authorize(op);
      if (op === "update" && (edit.policyNames !== undefined || (!status && edit.text === undefined && edit.schedule === undefined && edit.expiresAfter === undefined && edit.missedRuns === undefined && edit.overlap === undefined))) {
        throw new ReminderError("invalid_input", "Expected a nonempty reminder patch with immutable policies");
      }
      const live = this.options.running?.() ? this.options.live : undefined;
      const acceptedAt = (this.options.now ?? Date.now)();
      const retryKey = JSON.stringify([op, status, edit], (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
      const prepared = await this.transact(async (repo) => {
        const rows = (await repo.list()).filter((row) => row.conversationId === conversationId);
        const retry = rows.filter(row => op === "create" || row.id === id)
          .map(row => row.changes.at(-1))
          .find(change => change?.state === "maybe_sent" && change.reason === "storage_failure" && change.retryKey === retryKey);
        if (retry) {
          id = retry.reminder.id;
          return { reminder: retry.reminder, change: retry, retry: true };
        }
        const previous = rows.find((row) => row.id === id);
        const existing = previous && view(previous);
        const confirmed = previous?.confirmed;
        if (op !== "create" && confirmed && ["completed", "cancelled", "expired"].includes(confirmed.status)) {
          if (op === "cancel") return { unchanged: { ...confirmed, state: "confirmed" as const } };
          throw new ReminderError("conflict", "Reminder is already terminal");
        }
        const last = previous?.changes.at(-1);
        if (op !== "create" && last?.op === "cancel" && (last.state === "pending" || last.state === "maybe_sent")) {
          if (op === "cancel") return { unchanged: { ...last.reminder, state: last.state } };
          throw new ReminderError("conflict", "Reminder already has a cancellation in progress");
        }
        if (op !== "create" && (!existing || (!confirmed && last?.op === "create" && last.state === "blocked"))) throw new ReminderError("not_found", "Reminder was not found");
        const routine = edit.schedule ? isRoutineSchedule(edit.schedule) : isRoutineSchedule(existing?.schedule);
        if (op !== "create" && edit.schedule && routine !== isRoutineSchedule(existing?.schedule)) {
          throw new ReminderError("invalid_schedule", "Reminder schedule kind cannot change");
        }
        if (edit.schedule && existing && routine && ("every" in edit.schedule) !== ("every" in existing.schedule)) {
          throw new ReminderError("invalid_schedule", "Routine schedule kind cannot change");
        }
        if (routine && (op === "create" || edit.schedule || status === "active")) {
          const why = this.options.routineUnavailable ? this.options.routineUnavailable() : "Routine reminders are unavailable";
          if (why !== undefined) throw new ReminderError("routines_unavailable", why);
        }
        if ((!routine && (edit.missedRuns !== undefined || edit.overlap !== undefined)) ||
          (edit.missedRuns !== undefined && !["coalesce", "skip", "each"].includes(edit.missedRuns)) ||
          (edit.overlap !== undefined && !["skip", "queue"].includes(edit.overlap))) {
          throw new ReminderError("invalid_input", "Invalid routine missed-run or overlap policy");
        }
        if (!live && !repo.durable) {
          throw new ReminderError("reminders_unavailable", "Reminders require a live service or durable persistence");
        }
        const schedule = edit.schedule
          ? normalizeReminderSchedule(edit.schedule, acceptedAt, this.limits, op === "update")
          : existing!.schedule;
        const expiryPolicy = edit.expiresAfter !== undefined || !existing
          ? reminderExpiryPolicy(edit.expiresAfter, this.limits) : existing.expiryPolicy;
        const scheduleAcceptedAt = edit.schedule ? acceptedAt : existing?.scheduleAcceptedAt ?? acceptedAt;
        const expiry = edit.schedule || edit.expiresAfter !== undefined
          ? resolveReminderExpiry(schedule, expiryPolicy, scheduleAcceptedAt, this.limits)
          : existing!.expiry;
        const text = edit.text ?? existing!.text;
        if (!text.trim()) throw new ReminderError("invalid_input", "Reminder text is required");
        const policyNames = edit.policyNames ?? existing?.policyNames;
        const reminder: Reminder = {
          ...(routine ? previous?.changes.findLast(change => change.state !== "applied")?.reminder ?? confirmed ?? {} : {}),
          id, conversationId, text, schedule, expiry, expiryPolicy, scheduleAcceptedAt,
          status: status ?? existing?.status ?? "active",
          ...(routine ? {
            missedRuns: edit.missedRuns ?? existing?.missedRuns ?? "coalesce",
            overlap: edit.overlap ?? existing?.overlap ?? "skip",
            ...(edit.schedule ? { remainingCount: "count" in schedule ? schedule.count : undefined } : {}),
          } : {}),
          ...(policyNames === undefined ? {} : { policyNames }),
        };
        const fields: NonNullable<ReminderChange["fields"]>[number][] = [];
        if (edit.text !== undefined) fields.push("text");
        if (edit.schedule !== undefined) fields.push("schedule");
        if (edit.expiresAfter !== undefined) fields.push("expiry");
        if (status !== undefined) fields.push("status");
        if (edit.policyNames !== undefined) fields.push("policyNames");
        if (edit.missedRuns !== undefined) fields.push("missedRuns");
        if (edit.overlap !== undefined) fields.push("overlap");
        const pending = await repo.enqueue({ reminder, acceptedAt, op, fields, ...(routine && live ? { retryKey } : {}) });
        const outgoing = pending && live ? await repo.markMaybeSent(id, pending.changeId) : pending;
        return { reminder, change: outgoing };
      });
      if (prepared.unchanged) return prepared.unchanged;
      let result: ReminderView = { ...prepared.reminder, state: prepared.change?.state === "maybe_sent" ? "maybe_sent" : "pending" };
      if (!prepared.retry) emit({ kind: prepared.change ? "reminder_intent_recorded" : "reminder_intent_discarded", reminder: result });
      if (live && prepared.change) {
        const outcome = await live(reminderRequest(prepared.change, this.limits), prepared.change);
        if ("retryable" in outcome) {
          await this.repository.deferStorageFailure(id, prepared.change.changeId);
          return { ...result, reason: "storage_failure" };
        }
        await this.repository.acknowledge(id, prepared.change.changeId, outcome);
        result = "reason" in outcome
          ? { ...result, state: "blocked", reason: outcome.reason }
          : { ...outcome.confirmed, state: "confirmed" };
        emit({ kind: result.state === "blocked" ? "reminder_intent_blocked" : "reminder_intent_confirmed", reminder: result });
      }
      return result;
    };
    return {
      create: (input: ReminderCreate) => mutate("create", randomUUID(), input),
      get: async (id: string) => (await list(id)).find((item) => item.id === id),
      list: () => list(),
      update: (id: string, input: ReminderEdit) => mutate("update", id, input),
      pause: (id: string) => mutate("update", id, {}, "paused"),
      resume: (id: string) => mutate("update", id, {}, "active"),
      cancel: (id: string) => mutate("cancel", id, {}, "cancelled"),
      discardBlocked: async (id: string) => {
        check();
        authorize("update");
        const discarded = await this.transact(async (repo) => {
          const row = (await repo.list()).find(row => row.id === id && row.conversationId === conversationId);
          const item = row && view(row);
          if (item?.state !== "blocked") return;
          await repo.discardBlocked(id);
          return item;
        });
        if (discarded) emit({ kind: "reminder_intent_discarded", reminder: discarded });
      },
    };
  }
}

export function createAgentReminderService(
  host: NativeHarnessHost | null,
  persistence: PersistenceBackend,
  options?: Pick<ReminderServiceOptions, "authorize" | "limits">,
  log = noopLogger,
): ReminderService {
  const service = new ReminderService({
    ...options, persistence,
    running: () => host?.state === "running" && host.reminderSync?.supported === true,
    supported: () => host?.reminderSync?.supported,
    routineUnavailable: () => host?.reminderSync
      ? host.reminderSync.routineAdmission.unavailable() : "Routine reminders are unavailable",
    negotiatedLimits: () => host?.reminderSync?.supported === true ? host.reminderSync.limits : undefined,
    refresh: async (channel, id) => { await host?.refreshReminders(channel, id); },
    live: async (change) => await host?.changeReminder(change) ?? { reason: "not_found" },
  });
  if (host) {
    host.reminderSync = new ReminderSync(persistence, service.repository, log);
    host.armIdleStop(async () => {
      const rows = await service.repository.list();
      return {
        held: rows.some(row => row.changes.some(change => change.state === "pending" || change.state === "maybe_sent")),
        channels: rows.filter(row => row.confirmed?.status === "active" && row.confirmed.nextRunAt != null).map(row => row.conversationId),
      };
    });
    if (persistence instanceof SqliteAgentPersistence && persistence.ownsReminderWake) {
      host.reminderWake = new ReminderWakeSupervisor({
        state: () => host.reminderWakeState,
        index: () => service.repository.wake(host.state === "running" && host.reminderSync?.routineAdmission.available === true),
        subscribe: listener => persistence.subscribeReminderWake(listener),
        start: now => host.startForReminder(now),
        error: error => log.warn("reminder_wake_failed", { error: String(error) }),
      }, host.reminderTimer);
      host.reminderWake.subscribeHost(listener => host.subscribeState(listener));
    }
  }
  return service;
}
