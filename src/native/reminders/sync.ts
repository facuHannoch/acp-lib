import { RoutineAdmission } from "./routine-guard.ts";
import { isRoutineSchedule } from "./routine-schedule.ts";
import { type ReminderWireRow, type ReminderWireResult, type ReminderWireList, type ReminderWireOpen } from "./routine-wire.ts";
import type { AgentConversationId } from "../../agent-ids.ts";
import type { Logger } from "../../logger.ts";
import type { HarnessClient } from "../../native-harness/src/client.ts";
import type { PersistenceBackend, PersistenceScope } from "../../persistence/backend.ts";
import type { ReminderChange, ReminderPersistence } from "../../persistence/reminders.ts";
import { codeOf } from "../errors.ts";
import { defaultReminderLimits } from "./limits.ts";
import {
  fromWireReminder, negotiatedLimits, routineReminderRequest,
  type HarnessDescription, type ReminderNotification, type WireChange, type WireReminderEvent,
} from "./wire.ts";

const batchLimit = 100;
const sweepAttempts = 3;

export class ReminderSync {
  supported?: boolean;
  readonly routineAdmission = new RoutineAdmission();
  limits = defaultReminderLimits;
  unreconciled = false;
  private sessionId?: string;
  private tail = Promise.resolve();
  private sends = Promise.resolve();
  private readonly fires = new Set<string>();

  constructor(
    private readonly persistence: PersistenceBackend,
    private readonly repository: ReminderPersistence,
    private readonly log: Logger,
  ) {}

  private transaction<T>(work: (repo: ReminderPersistence, scope: PersistenceScope) => Promise<T>): Promise<T> {
    return this.persistence.reminders
      ? this.persistence.transaction(scope => work(scope.reminders!, scope))
      : work(this.repository, this.persistence);
  }

  private ordered<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  settled(): Promise<void> { return this.tail; }

  async initialize(offered: {
    capabilities?: Pick<Partial<HarnessDescription["capabilities"]>, "reminders"> & {
      routines?: boolean; unattendedTurnGuard?: boolean;
    };
    reminderLimits?: Parameters<typeof negotiatedLimits>[0];
  }): Promise<void> {
    this.supported = offered.capabilities?.reminders === true;
    this.routineAdmission.initialize(offered.capabilities?.routines, offered.capabilities?.unattendedTurnGuard, this.supported);
    this.limits = negotiatedLimits(offered.reminderLimits, this.routineAdmission.supported);
    await this.repository.setSupported(this.supported);
  }

  async stage(include: (change: ReminderChange) => boolean = () => true, originals?: ReminderChange[]): Promise<WireChange[]> {
    if (!this.supported) return [];
    return this.transaction(async repo => {
      const entries = (await repo.list()).flatMap(row => row.changes)
        .filter(change => change.state === "pending" || change.state === "maybe_sent")
        .sort((a, b) => a.stagingOrder - b.stagingOrder);
      const batch: WireChange[] = [];
      let bytes = 0;
      const held = new Set<string>();
      for (const change of entries) {
        if (batch.length === batchLimit) break;
        const id = change.reminder.id;
        if (held.has(id)) continue;
        if (isRoutineSchedule(change.reminder.schedule) && !this.routineAdmission.advertised) {
          await repo.quarantine(id, change.changeId, change.reminder.missedRuns === undefined ? "invalid_local_entry" : "routines_unavailable");
          continue;
        }
        if (!include(change)) {
          held.add(id);
          continue;
        }
        try {
          const wire = change.frozenWire ?? routineReminderRequest(change, this.limits);
          const size = Buffer.byteLength(JSON.stringify(wire)) + 1;
          if (size > 900_000) throw new Error("Reminder entry exceeds startup frame budget");
          if (bytes + size > 900_000) break;
          if (await repo.markMaybeSent(wire.reminderId, wire.changeId, wire)) {
            originals?.push(change);
            batch.push(wire);
            bytes += size;
          }
        } catch (error) {
          this.log.warn("reminder_entry_quarantined", { id: change.reminder.id, error: String(error) });
          await repo.quarantine(change.reminder.id, change.changeId, "invalid_local_entry");
        }
      }
      return batch;
    });
  }

  async restoreStaged(originals: ReminderChange[]): Promise<void> {
    await this.transaction(async repo => {
      for (const change of originals) await repo.restoreStaged(change);
    });
  }

  async rejectedBatch(batch: WireChange[]): Promise<void> {
    // A successful retry isolates the reminder batch. Quarantine it whole.
    this.log.warn("reminder_batch_rejected", { count: batch.length });
    await this.transaction(async repo => {
      for (const entry of batch) await repo.quarantine(entry.reminderId, entry.changeId, "invalid_params");
    });
  }

  async startupRetry(id: string): Promise<WireChange[] | undefined> {
    const retry = (await this.repository.wake()).startupRetry;
    return retry?.sessionId === id ? [...retry.entries] : undefined;
  }

  async freezeStartupRetry(sessionId: string, entries: readonly WireChange[]): Promise<void> {
    await this.repository.setStartupRetry({ sessionId, entries });
  }

  async replacementAttempted(id: string): Promise<boolean> {
    return (await this.repository.wake()).replacementAttempted === id;
  }

  async setReplacementAttempted(id: string | undefined): Promise<void> {
    await this.repository.setReplacementAttempted(id);
  }

  async opened(client: HarnessClient, result: ReminderWireOpen, configuredId: string, fresh: boolean): Promise<void> {
    if (!this.supported) return;
    const sessionId = result.sessionId ?? configuredId;
    const wake = await this.repository.wake();
    const saved = wake.reported?.sessionId;
    if (fresh || wake.replacementAttempted === configuredId || ((this.sessionId ?? saved) !== undefined && (this.sessionId ?? saved) !== sessionId)) {
      this.fires.clear();
      await this.repository.replaceSession(sessionId);
      await this.transaction(async repo => {
        for (const receipt of result.reminderChanges ?? []) await repo.markMaybeSent(receipt.reminderId, receipt.changeId);
      });
    }
    this.sessionId = sessionId;
    this.routineAdmission.opened(result);
    await this.ordered(async () => {
      for (const receipt of result.reminderChanges ?? []) await this.recordReceipt(receipt);
      if (result.reminderRevision !== undefined && result.nextDueAt !== undefined) {
        await this.deadline(result.nextDueAt, result.reminderRevision);
      }
      if (result.reminders) await this.sweep(client, undefined, { reminders: result.reminders, next: result.remindersNext });
      if (wake.startupRetry?.sessionId === configuredId) await this.repository.setStartupRetry(undefined);
    });
  }

  private async deadline(nextDueAt: string | null, revision: number) {
    if (!this.sessionId) return;
    const result = await this.repository.updateDeadline({
      sessionId: this.sessionId, revision, nextDueAt: nextDueAt === null ? null : Date.parse(nextDueAt),
    });
    if (result === "mismatch") this.log.warn("reminders_due_revision_conflict", { revision, nextDueAt });
  }

  private async recordReceipt(receipt: ReminderWireResult) {
    const { reminderId, changeId } = receipt;
    if (receipt.outcome === "blocked") {
      const { reason } = receipt;
      if (reason === "stale" || reason === "conflict") this.log.warn("reminder_receipt_conflict", { reminderId, changeId, reason });
      const blocked = { reason: reason ?? "invalid_state" };
      await this.repository.acknowledge(reminderId, changeId, blocked);
      return blocked;
    }
    const { reminder } = receipt;
    if (!reminder) throw new Error("Applied reminder receipt has no row");
    const journal = (await this.repository.list()).find(row => row.id === reminderId);
    const prior = journal?.changes.find(change => change.changeId === changeId)?.reminder ?? journal?.confirmed;
    const confirmed = fromWireReminder(reminder, prior);
    await this.repository.acknowledge(reminderId, changeId, { confirmed });
    return { confirmed: (await this.repository.list()).find(row => row.id === reminderId)?.confirmed ?? confirmed };
  }

  private async storeRows(rows: ReminderWireRow[], seen: Set<string>): Promise<void> {
    await this.transaction(async (repo, scope) => {
      const known = await repo.list();
      for (const row of rows) {
        const conversation = await scope?.conversations.get(row.channel as AgentConversationId);
        if (!conversation || conversation.deletedAt) continue;
        seen.add(row.id);
        const journal = known.find(item => item.id === row.id);
        await repo.observe(fromWireReminder(row, journal?.confirmed ?? journal?.changes.at(-1)?.reminder));
      }
    });
  }

  private async sweep(client: HarnessClient, channel?: string, first?: ReminderWireList): Promise<void> {
    for (let attempt = 0; attempt < sweepAttempts; attempt++) {
      const seen = new Set<string>();
      try {
        let page = attempt === 0 ? first : undefined;
        let after: string | undefined;
        do {
          page ??= await client.listReminders({ ...(channel ? { channel } : {}), ...(after ? { after } : {}) });
          await this.storeRows(page.reminders, seen);
          after = page.next;
          page = undefined;
        } while (after);
        if (!channel) await this.repository.completeSweep(seen);
        this.unreconciled = false;
        return;
      } catch (error) {
        if (codeOf(error) !== "invalid_cursor") throw error;
      }
    }
    this.unreconciled = true;
    this.log.warn("reminder_sweep_unreconciled", { channel });
  }

  refresh(client: HarnessClient, channel?: string, id?: string): Promise<void> {
    return this.ordered(async () => {
      if (!this.supported) return;
      if (!id) return this.sweep(client, channel);
      try {
        const { reminder } = await client.getReminder({ id });
        if (reminder.channel === channel) await this.storeRows([reminder], new Set());
      } catch (error) {
        if (codeOf(error) !== "not_found") throw error;
      }
    });
  }

  dispatch(client: HarnessClient, target?: WireChange) {
    const result = this.sends.then(async () => {
      let own: Awaited<ReturnType<ReminderSync["recordReceipt"]>> | undefined;
      for (;;) {
        const batch = await this.stage();
        if (!batch.length) break;
        for (const entry of batch) {
          const send = () => client.changeReminder(entry);
          let receipt: ReminderWireResult | undefined;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try { receipt = await send(); break; }
            catch (error) { if (codeOf(error) !== "storage_failure") throw error; }
          }
          if (!receipt) {
            await this.repository.deferStorageFailure(entry.reminderId, entry.changeId);
            this.log.warn("reminder_live_retry_exhausted", { id: entry.reminderId, changeId: entry.changeId });
            return target ? { retryable: true as const } : undefined;
          }
          if (receipt.reminderId !== entry.reminderId || receipt.changeId !== entry.changeId) throw new Error("Mismatched reminder receipt");
          const received = receipt;
          const outcome = await this.ordered(() => this.recordReceipt(received));
          if (entry.reminderId === target?.reminderId && entry.changeId === target.changeId) own = outcome;
        }
        if (own) break;
      }
      if (target && !own) {
        const journal = (await this.repository.list()).find(row => row.id === target.reminderId);
        const terminal = journal?.changes.find(change => change.changeId === target.changeId);
        return terminal?.reason ? { reason: terminal.reason } : journal?.confirmed ? { confirmed: journal.confirmed } : { reason: "not_found" };
      }
      return own;
    });
    this.sends = result.then(() => {}, () => {});
    return result;
  }

  notification(notification: ReminderNotification, emit: (channel: string, event: WireReminderEvent) => void) {
    void this.ordered(async () => {
      if ("deadline" in notification) return this.deadline(notification.deadline.nextDueAt, notification.deadline.revision);
      const { channel, event } = notification;
      if (event.kind === "reminder_fired" && (this.fires.has(event.occurrenceId) || this.fires.has(event.noticeId))) return;
      const conversation = await this.persistence.conversations.get(channel as AgentConversationId);
      if (!conversation || conversation.deletedAt) return;
      if (event.kind === "routine_disposition" || event.kind === "routine_migration_blocked") {
        emit(channel, event);
        return;
      }
      if (event.kind === "reminder_changed" && event.reminder.channel === channel) await this.storeRows([event.reminder], new Set());
      if (event.kind !== "reminder_changed") {
        await this.transaction(async (repo, scope) => {
          const row = await scope?.conversations.get(channel as AgentConversationId);
          if (!row || row.deletedAt) return;
          const confirmed = (await repo.list()).find(item => item.id === event.reminderId && item.conversationId === channel)?.confirmed;
          if (!confirmed) return;
          const status = event.kind === "reminder_fired" ? "completed" : event.kind === "reminder_expired" ? "expired" : "cancelled";
          const routineFire = event.kind === "reminder_fired" && isRoutineSchedule(confirmed.schedule);
          await repo.observe({ ...confirmed, ...(!routineFire ? { status, nextRunAt: null } : {}), ...(event.kind === "reminder_fired"
            ? { lastRunAt: Date.parse(event.firedAt), lastOccurrenceId: event.occurrenceId, noticeId: event.noticeId } : {}) });
        });
      }
      if (event.kind === "reminder_fired") {
        this.fires.add(event.occurrenceId);
        this.fires.add(event.noticeId);
      }
      emit(channel, event);
    }).catch(error => this.log.warn("reminder_event_failed", { error: String(error) }));
  }
}
