import { HarnessClientError, type HarnessClient } from "../../../src/native-harness/src/client.ts";
import type { ReminderWireChange, ReminderWireOpen, ReminderWireResult, RoutineConfig, RoutineRow } from "../../../src/native/reminders/routine-wire.ts";

type Method = "open" | "create" | "change";
type Startup = {
  sessionId: string;
  config?: RoutineConfig;
  reminderChanges?: ReminderWireChange[];
  channelChanges?: Array<{ channel: string }>;
};

const fail = (code: string) => new HarnessClientError(code, code);

/** Controlled 0032 peer for startup ordering, receipt and guard assertions.
 * It uses scripted rows rather than implementing the harness calendar. */
export class RoutinePeer {
  readonly calls: Array<{ method: Method; params: Startup | ReminderWireChange }> = [];
  readonly trace: string[] = [];
  readonly rows = new Map<string, RoutineRow>();
  readonly receipts = new Map<string, ReminderWireResult>();
  readonly sessions = new Set<string>();
  guard: number | null = null;
  failBeforeCreate?: "transport_closed" | "timeout";
  failId?: string;
  failures = 0;
  blockActivation = false;
  beforeStartupBatch?: () => Promise<void>;
  afterLiveChange?: (change: ReminderWireChange) => void;
  readonly sessionId = "routine-session";
  readonly client = {
    openSession: (params: Startup) => this.start("open", params),
    createSession: (params: Startup) => this.start("create", params),
    changeReminder: async (change: ReminderWireChange) => {
      this.calls.push({ method: "change", params: structuredClone(change) });
      const result = this.change(change);
      this.afterLiveChange?.(change);
      return result;
    },
    listReminders: async () => ({ reminders: [...this.rows.values()] }),
    getReminder: async ({ id }: { id: string }) => {
      const reminder = this.rows.get(id);
      if (!reminder) throw fail("not_found");
      return { reminder };
    },
  } as unknown as HarnessClient;

  private async start(method: "open" | "create", params: Startup): Promise<ReminderWireOpen> {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "open" && !this.sessions.has(params.sessionId)) throw fail("not_found");
    if (method === "create" && this.sessions.has(params.sessionId)) throw fail("already_exists");
    if (method === "create" && this.failBeforeCreate) {
      const error = this.failBeforeCreate;
      this.failBeforeCreate = undefined;
      throw fail(error);
    }
    const configured = params.config?.limits?.unattendedTurns;
    if (configured !== undefined && this.guard !== null && configured !== this.guard) throw fail("invalid_config");
    if (configured !== undefined) this.guard = configured;
    this.sessions.add(params.sessionId);
    this.trace.push("guard");
    for (const entry of params.channelChanges ?? []) this.trace.push("channel:" + entry.channel);
    await this.beforeStartupBatch?.();
    const reminderChanges = (params.reminderChanges ?? []).map(change => this.change(change));
    this.trace.push("due");
    return {
      sessionId: params.sessionId, lifecycle: "running", revision: 0, reminderChanges,
      reminders: [...this.rows.values()], nextDueAt: null, reminderRevision: 0,
      unattendedTurnGuard: this.guard === null ? null : { maxConsecutiveTurns: this.guard },
    };
  }

  change(change: ReminderWireChange): ReminderWireResult {
    const { reminderId, changeId, op, payload } = change;
    const key = JSON.stringify([reminderId, changeId]);
    const seen = this.receipts.get(key);
    this.trace.push((seen ? "replay:" : "change:") + reminderId);
    if (seen) return structuredClone(seen);
    if ((reminderId === this.failId || this.failId === "*") && this.failures > 0) {
      this.failures--;
      throw fail("storage_failure");
    }
    const activate = op === "create" || (op === "update" && (payload.schedule !== undefined || payload.state === "active"));
    let row = this.rows.get(reminderId);
    let result: ReminderWireResult;
    if (activate && (this.guard === null || this.blockActivation)) {
      result = { reminderId, changeId, outcome: "blocked", reason: "unattended_guard_required" };
    } else if (op === "create" && "every" in payload.schedule) {
      const schedule = payload.schedule;
      const startAt = schedule.startAt ?? new Date(Date.parse(payload.acceptedAt) + schedule.every).toISOString();
      row = {
        id: reminderId, channel: payload.channel, createdBy: "host", text: payload.text,
        policyNames: payload.policyNames ?? [], state: "active", acceptedAt: payload.acceptedAt,
        schedule: { ...schedule, startAt }, nextRunAt: startAt, expiresAt: null, expiresAfter: null,
        missedRuns: "missedRuns" in payload ? payload.missedRuns ?? "coalesce" : "coalesce",
        overlap: "overlap" in payload ? payload.overlap ?? "skip" : "skip",
      };
      result = { reminderId, changeId, outcome: "applied", reminder: row };
    } else if (row && op !== "create") {
      row = op === "cancel" ? { ...row, state: "cancelled", nextRunAt: null }
        : { ...row, text: payload.text ?? row.text, state: payload.state ?? row.state };
      result = { reminderId, changeId, outcome: "applied", reminder: row };
    } else {
      result = { reminderId, changeId, outcome: "blocked", reason: "not_found" };
    }
    if (result.outcome === "applied" && row) this.rows.set(reminderId, row);
    this.receipts.set(key, structuredClone(result));
    return result;
  }
}
