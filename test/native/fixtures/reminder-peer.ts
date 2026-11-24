import { HarnessClientError, type HarnessClient } from "../../../src/native-harness/src/client.ts";
import type { WireChange, WireReceipt, WireReminder, ReminderPage } from "../../../src/native/reminders/wire.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failure = (code: string) => new HarnessClientError(code, code);
const instant = (ms: number) => new Date(ms).toISOString();

export class ReminderPeer {
  readonly traffic: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly rows = new Map<string, WireReminder>();
  readonly receipts = new Map<string, { request: WireChange; outcome: WireReceipt }>();
  readonly original = new Map<string, unknown>();
  readonly defaulted = new Set<string>();
  readonly highWater = new Map<string, number>();
  readonly channelOrder: string[] = [];
  listingRevision = 0;
  revision = 0;
  nextDueAt: string | null = null;
  sessionId = "session";
  fresh = false;
  rejectBatch = false;
  invalidatePages = 0;
  recomputeDefaultOnScheduleEdit = true;
  now = 1_000_000;
  readonly client = {
    request: (method: string, params: Record<string, unknown>) => this.request(method, params),
    openSession: (params: Record<string, unknown>) => this.request("session/open", params),
    createSession: (params: Record<string, unknown>) => this.request("session/create", params),
  } as unknown as HarnessClient;

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.traffic.push({ method, params: structuredClone(params) });
    if (method === "session/open" || method === "session/create") {
      if (method === "session/open" && this.fresh) throw failure("not_found");
      const changes = (params.reminderChanges ?? []) as WireChange[];
      if (changes.length > 100 || (changes.length && this.rejectBatch)) throw failure("invalid_params");
      for (const value of (params.channelChanges ?? []) as Array<{ channel: string }>) this.channelOrder.push(value.channel);
      const reminderChanges = changes.map(change => this.apply(change));
      const page = this.page({});
      return { sessionId: this.sessionId, reminderChanges, nextDueAt: this.nextDueAt, reminderRevision: this.revision,
        reminders: page.reminders, remindersNext: page.next };
    }
    if (method === "reminder/change") return this.apply(params as WireChange);
    if (method === "reminder/get") {
      const reminder = this.rows.get(params.id as string);
      if (!reminder) throw failure("not_found");
      return { reminder: structuredClone(reminder) };
    }
    if (method === "reminder/list") return this.page(params);
    throw failure("method_not_found");
  }

  private page(params: Record<string, unknown>): ReminderPage {
    const { channel, after, limit = 50 } = params as { channel?: string; after?: string; limit?: number };
    const scope = channel ?? "";
    let offset = 0;
    if (after) {
      const [session, cursorScope, revision, index] = JSON.parse(after);
      if (this.invalidatePages > 0) { this.invalidatePages--; throw failure("invalid_cursor"); }
      if (session !== this.sessionId || cursorScope !== scope || revision !== this.listingRevision) throw failure("invalid_cursor");
      offset = index;
    }
    const rows = [...this.rows.values()].filter(row => !channel || row.channel === channel);
    return {
      reminders: structuredClone(rows.slice(offset, offset + limit)),
      ...(offset + limit < rows.length ? { next: JSON.stringify([this.sessionId, scope, this.listingRevision, offset + limit]) } : {}),
    };
  }

  apply(request: WireChange): WireReceipt {
    const { reminderId, changeId, op, payload } = request;
    const key = JSON.stringify([reminderId, changeId]);
    const blocked = (reason: string): WireReceipt => ({ reminderId, changeId, outcome: "blocked", reason });
    const validFields = op === "create" ? ["channel", "schedule", "text", "acceptedAt", "policyNames", "expiresAfter"]
      : op === "update" ? ["schedule", "acceptedAt", "text", "state", "expiresAfter"] : [];
    if (Object.keys(payload).some(field => !validFields.includes(field)) ||
      (op === "update" && (!Object.keys(payload).length || ("schedule" in payload) !== ("acceptedAt" in payload)))) throw failure("invalid_params");
    const previous = this.receipts.get(key);
    if (previous) return same(previous.request, request) ? structuredClone(previous.outcome) : blocked("conflict");
    const high = this.highWater.get(reminderId) ?? 0;
    if (changeId < high) return blocked("stale");
    let row = this.rows.get(reminderId);
    const finish = (outcome: WireReceipt) => {
      this.highWater.set(reminderId, changeId);
      this.receipts.set(key, structuredClone({ request, outcome }));
      return outcome;
    };
    const anchor = "acceptedAt" in payload ? Date.parse(payload.acceptedAt!) : (row ? Date.parse(row.acceptedAt) : 0);
    const at = "schedule" in payload ? Date.parse(payload.schedule!.at) : (row ? Date.parse(row.schedule.at) : 0);
    const submittedGrace = "expiresAfter" in payload ? payload.expiresAfter : undefined;
    if ("schedule" in payload && (!Number.isFinite(at) || !Number.isFinite(anchor) || anchor > this.now + 30_000 || at - anchor < 120_000)) {
      return finish(blocked("invalid_schedule"));
    }
    if (typeof submittedGrace === "number" && (!Number.isSafeInteger(submittedGrace) || submittedGrace < 300_000 || submittedGrace > 86_400_000)) {
      return finish(blocked("invalid_schedule"));
    }
    const applied = (): WireReceipt => ({ reminderId, changeId, outcome: "applied", reminder: structuredClone(row!) });
    if (op === "create" && this.original.has(reminderId)) {
      return finish(row && same(this.original.get(reminderId), payload) ? applied() : blocked("conflict"));
    }
    if (op === "create") {
      this.original.set(reminderId, structuredClone(payload));
      if (!this.channelOrder.includes(payload.channel!)) return finish(blocked("channel_missing"));
      if (submittedGrace === undefined) this.defaulted.add(reminderId);
      row = { id: reminderId, channel: payload.channel!, createdBy: "host", policyNames: [...(payload.policyNames ?? [])],
        schedule: { at: instant(at) }, text: payload.text!, state: "active", nextRunAt: instant(at),
        acceptedAt: instant(anchor), expiresAfter: null, expiresAt: null };
    } else if (!row) return finish(blocked("not_found"));
    else if (["done", "cancelled", "expired"].includes(row.state)) return finish(op === "cancel" ? applied() : blocked("invalid_state"));
    else if (op === "cancel") row = { ...row, state: "cancelled", nextRunAt: null };
    else {
      const state = payload.state ?? row.state;
      row = { ...row, state, text: payload.text ?? row.text, acceptedAt: instant(anchor),
        schedule: { at: instant(at) }, nextRunAt: state === "active" ? instant(at) : null };
    }
    if (op !== "cancel") {
      const recalculate = op === "create" || (this.defaulted.has(reminderId) && this.recomputeDefaultOnScheduleEdit && "schedule" in payload);
      const grace = submittedGrace !== undefined ? submittedGrace : recalculate
        ? Math.min(86_400_000, Math.max(300_000, 2 * (at - anchor))) : row.expiresAfter;
      row = { ...row, expiresAfter: grace, expiresAt: grace === null ? null : instant(at + grace) };
      if (submittedGrace !== undefined) this.defaulted.delete(reminderId);
    }
    this.rows.set(reminderId, row);
    this.listingRevision++;
    return finish(applied());
  }
}
