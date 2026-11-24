import { resolveRoutineZone } from "../../capabilities/reminders/iana-zones.ts";
import { SESSION_INTAKE_LIMITS } from "../../util/intake.ts";
import { advanceRoutine } from "../../capabilities/reminders/routine-advance.ts";
import { planRoutineEpisode } from "../../capabilities/reminders/routine-occurrence.ts";
import { createRoutineEvaluator } from "../../capabilities/reminders/routine-schedule.ts";
import { isRoutine, prepareRoutineRow } from "./routine-row.ts";
import { unattendedAdmission } from "../../capabilities/reminders/unattended.ts";
import { normalizeReminderSchedule, resolveAgentReminder } from "../../util/reminder-schedule.ts";
import { applyReminderChange } from "./reminder-change.ts";
import type { OneOffReminder, Reminder, ReminderChannelEvent } from "../../contracts/reminders.ts";
import type { ReminderTables } from "./reminder-tables.ts";
import { searchTimeline, readMessageWindow } from "./retrieval.ts";
import type { InspectionEntry } from "../../contracts/inspection.ts";
import type { ContextTurnOutcome } from "../../contracts/context.ts";
import type { IntakeLimit } from "../../contracts/input-limits.ts";
import type { OperatorStorageReads } from "../../contracts/operator-controls.ts";
import type { ModelCallSummary } from "../../contracts/model-execution.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";
import { externalNoticeSignature, policyItemSignature, contributingPolicies, fingerprint } from "./policy-metadata.ts";
import { byteLength, readInference, validReadLimits, type ContextRows } from "./inference.ts";
import { validateManagedConfig } from "../../util/config.ts";
import type {
  AcceptItem, ChannelLifecycle, SessionArchive, SessionLifecycle, SessionStorage, StorageErrorCode, StorageResult,
  StorageSnapshot, StoredChannel, StoredItem, StoredSession, StoredTurn, TimelineEntry, TurnTake,
} from "../../contracts/storage.ts";

/** Session-wide scalars. `revision` is also the last allocated global seq. */
export interface Meta {
  sessionId: string; formatVersion: number; createdAt: string; compatibilityKey: string;
  lifecycle: SessionLifecycle; revision: number; nextTurnId: number; nextItemNumber: number;
}
/** A channel as stored; `participantIds` is derived from the timeline. */
export type ChannelRow = Omit<StoredChannel, "participantIds">;
/** A turn as stored; `itemIds` is derived from the items linked to it. */
export type TurnRow = Omit<StoredTurn, "itemIds">;

/** Model-call metadata is stored transactionally alongside the logical rows. */
export interface ModelState {
  nextCall: number;
  calls: ModelCallSummary[];
  itemIds: Record<string, string[]>;
  scriptPositions: Record<string, number>;
  entryIds: Record<string, string>;
}
export const emptyModelState = (): ModelState => ({ nextCall: 1, calls: [], itemIds: {}, scriptPositions: {}, entryIds: {} });

/** Row access shared by the memory and SQLite adapters. The engine owns every
 * rule of the storage contract; a backend only stores rows and makes
 * `transaction` atomic (all writes of a throwing callback are undone). */
export interface Tables extends ContextRows {
  /** SQLite attachment metadata, absent in adapters without managed bytes. */
  attachments?: Pick<ReturnType<typeof import("./attachment-tables.ts").sqliteAttachmentTables>, "baseFormat" | "advanceBaseFormat" | "hasRetained">;
  reminders: ReminderTables;
  retrievalCandidates(terms: readonly string[], channel: string | undefined, limit: number): Array<{ seq: number; bytes: number }>;
  retrievalEntry(seq: number): TimelineEntry | undefined;
  retrievalReplyId(id: string): number | undefined;
  readRange(range: Parameters<OperatorStorageReads["readTimeline"]>[0]): TimelineEntry[];
  pendingCount(channel: string): number;
  getModelState(): ModelState | undefined;
  setModelState(state: ModelState, changed?: readonly ModelCallSummary[]): void;
  modelCallPage(after: string | undefined, count: number): ModelCallSummary[];
  /** Decision 0021: sorted names of revoked revocable tools; undefined if never written. */
  getRevokedTools(): string[] | undefined;
  setRevokedTools(names: string[]): void;
  getConfig(): import("../../contracts/session-file.ts").PortableSessionConfig | undefined;
  setConfig(config: import("../../contracts/session-file.ts").PortableSessionConfig): void;
  transaction<T>(run: () => T): T;
  getMeta(): Meta;
  setMeta(meta: Meta): void;
  channel(channelId: string): ChannelRow | undefined;
  /** Insert, or update name/lifecycle of an existing channel (position is kept). */
  putChannel(channel: ChannelRow): void;
  /** In creation order. */
  channels(): ChannelRow[];
  /** Idempotent. */
  addParticipant(participantId: string): void;
  participants(): string[];
  item(itemId: string): StoredItem | undefined;
  /** Insert, or update milestone/turn link of an existing item. */
  putItem(item: StoredItem): void;
  /** Milestone `received` (never `withdrawn`), in acceptedSeq order. */
  hasOpenRoutineNotice(channelId: string, source: string): boolean;
  pendingItems(channelId: string, limit?: number): StoredItem[];
  /** In take (entrySeq) order. */
  itemsOfTurn(turnId: number): StoredItem[];
  items(): StoredItem[];
  turn(turnId: number): TurnRow | undefined;
  /** Insert, or update state of an existing turn. */
  putTurn(turn: TurnRow): void;
  /** The channel's running or suspended turn. */
  liveTurn(channelId: string): TurnRow | undefined;
  turns(): TurnRow[];
  liveTurns(): TurnRow[];
  latestTurn(channel: string): TurnRow | undefined;
  policyNames(): string[];
  addEntry(entry: TimelineEntry): void;
  entriesOfTurn(turnId: number): TimelineEntry[];
  entries(): TimelineEntry[];
}

/** Check persisted names before recovery or config replacement. A changed
 * definition is permitted here; checkpoint compatibility is checked only when
 * that particular checkpoint would actually resume. */
export function referencesCompatible(tables: Tables, config?: ManagedConfig): boolean {
  if (!config) return true;
  return tables.policyNames().every(name => Object.hasOwn(config.policies, name));
}

export class Fail extends Error {
  constructor(readonly code: StorageErrorCode, message: string) { super(message); }
}
const fail = (code: StorageErrorCode, message: string): never => { throw new Fail(code, message); };
export function failure<T>(error: unknown): StorageResult<T> {
  return { ok: false, error: error instanceof Fail ? { code: error.code, message: error.message }
    : { code: "storage_failure", message: String(error) } };
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const AUTO = /^auto:(0|[1-9]\d*)$/;
const RANK = { received: 0, taken: 1, delivered: 2, seen: 3, withdrawn: 4 } as const;
const NAME_MAX = 200;
/** A display name as stored: trimmed, 1..200 characters. */
function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.trim().length > NAME_MAX)
    fail("invalid_input", `Display name must be 1..${NAME_MAX} characters`);
  return (name as string).trim();
}

/** The contract's exact signature; identical for both adapters and archives. */
export function signatureOf(item: Pick<AcceptItem, "kind" | "channelId" | "senderId" | "sourceChannelId" | "text" | "explicitPolicy" | "externalSource" | "inheritedPolicyNames">): string {
  return item.kind === "external_notice" ? externalNoticeSignature(item.channelId, item.externalSource, item.text, item.inheritedPolicyNames ?? []) : policyItemSignature(item);
}

/** Strict JSON data: what survives a JSON round trip unchanged. */
export function isJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let ok: boolean;
  if (Array.isArray(value)) ok = value.every(entry => isJson(entry, seen));
  else {
    const proto = Object.getPrototypeOf(value);
    ok = (proto === Object.prototype || proto === null) && Object.values(value).every(entry => isJson(entry, seen));
  }
  seen.delete(value);
  return ok;
}

type Stored = Extract<TimelineEntry["message"], { role: "assistant" | "tool" }>;
function checkMessage(message: unknown): Stored {
  if (!isJson(message)) fail("serialization_error", "Message is not plain JSON data");
  const m = message as Record<string, unknown>;
  const keys = Object.keys(m);
  if (m.role === "tool") {
    if (typeof m.content !== "string" || !text(m.callId) || keys.some(key => !["role", "content", "callId", "outcome"].includes(key)))
      fail("invalid_input", "Tool result needs content and callId");
    // Decision 0021: an optional, typed outcome. Checked here so a stored
    // result never claims a status the invocation view cannot interpret.
    if (m.outcome !== undefined) {
      const outcome = m.outcome as Record<string, any>, reference = outcome?.reference;
      if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || !["succeeded", "failed", "skipped", "interrupted"].includes(outcome.status)
        || Object.keys(outcome).some(key => !["status", "code", "reference"].includes(key)) || (outcome.code !== undefined && !text(outcome.code))
        || (reference !== undefined && (!reference || typeof reference !== "object" || !text(reference.resultId) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0
          || !["temporary", "durable"].includes(reference.retention) || (reference.expiresAt !== undefined && !text(reference.expiresAt))
          || Object.keys(reference).some(key => !["resultId", "bytes", "retention", "expiresAt"].includes(key)))))
        fail("invalid_input", "Invalid tool outcome");
    }
  } else if (m.role === "assistant") {
    const calls = m.calls;
    if (!(m.content === null || typeof m.content === "string") || !Array.isArray(calls)
      || keys.some(key => !["role", "content", "calls", "providerState"].includes(key))
      || calls.some(call => !call || typeof call !== "object" || !text(call.id) || !text(call.name) || typeof call.arguments !== "string"))
      fail("invalid_input", "Assistant message needs content and well-formed calls");
  } else fail("invalid_input", "Only assistant and tool messages can be appended");
  return message as Stored;
}

function session(meta: Meta): StoredSession {
  return { sessionId: meta.sessionId, formatVersion: meta.formatVersion >= 9 ? 9 : meta.formatVersion >= 8 ? 8 : meta.formatVersion === 7 ? 7 : 6, createdAt: meta.createdAt,
    lifecycle: meta.lifecycle, compatibilityKey: meta.compatibilityKey };
}

export function readSnapshot(tables: Tables): StorageSnapshot {
  const meta = tables.getMeta();
  const timeline = tables.entries();
  const spoke = new Map<string, Set<string>>();
  for (const entry of timeline) {
    if (entry.kind !== "participant_message") continue;
    if (!spoke.has(entry.channelId)) spoke.set(entry.channelId, new Set());
    spoke.get(entry.channelId)!.add(entry.from);
  }
  return {
    revision: meta.revision, session: session(meta),
    channels: tables.channels().map(row => ({ channelId: row.channelId, ...(row.displayName === undefined ? {} : { displayName: row.displayName }), ...(row.policy === undefined ? {} : { policy: row.policy }),
      lifecycle: row.lifecycle, participantIds: [...spoke.get(row.channelId) ?? []] })),
    participants: tables.participants().map(participantId => ({ participantId })),
    turns: tables.turns().map(row => ({ ...row, itemIds: tables.itemsOfTurn(row.turnId).map(item => item.itemId) })),
    items: tables.items(), timeline: timeline.map(entry => {
      const id = tables.getModelState()?.entryIds[String(entry.seq)];
      return id ? { ...entry, messageId: id } : entry;
    }),
    modelCalls: tables.getModelState()?.calls ?? [], scriptPositions: tables.getModelState()?.scriptPositions ?? {},
    ...(tables.getRevokedTools() === undefined ? {} : { revokedTools: tables.getRevokedTools()! }),
  };
}

/** Reopen recovery, one transaction, executes nothing. `upgrade` (format 2 data,
 * decision 0014) runs first in the same transaction, so a failure leaves the
 * data untouched. Interrupted: every running turn, and every checkpointed turn
 * whose channel is not individually `suspended` (a committed channel suspension
 * and its checkpoint survive, in every lifecycle); a clean session suspension
 * keeps all. A `suspending` channel never committed and returns to `open`. A
 * clean state with nothing to change is left unwritten. */
export function initialIntakeHasParticipant(items: readonly StoredItem[]) {
  let bytes = SESSION_INTAKE_LIMITS.maxTakenTextBytes;
  for (const [index, item] of items.entries()) {
    if (index >= SESSION_INTAKE_LIMITS.maxTakenItems) break;
    bytes -= byteLength(item.text);
    if (bytes < 0 && index > 0) break;
    if (item.kind === "participant_message") return true;
    if (bytes < 0) break;
  }
  return false;
}

function routineHeldChannels(tables: Tables, meta: Meta): string[] {
  const limit = meta.formatVersion >= 8 ? tables.reminders.guardLimit() : undefined;
  if (limit === undefined) return [];
  return tables.channels().filter(({ channelId, lifecycle }) => {
    if (lifecycle !== "open" || tables.reminders.guardSpent(channelId) < limit) return false;
    return !initialIntakeHasParticipant(tables.pendingItems(channelId, SESSION_INTAKE_LIMITS.maxTakenItems));
  }).map(channel => channel.channelId);
}

function refreshReminderWake(tables: Tables, meta: Meta) {
  if (meta.formatVersion < 7) return;
  const wake = tables.reminders.wake();
  const nextDueAt = meta.lifecycle === "running" ? tables.reminders.eligible(null, 1, routineHeldChannels(tables, meta))[0]?.reminder.nextRunAt ?? null : null;
  if (nextDueAt !== wake.nextDueAt) tables.reminders.setWake({ nextDueAt, reminderRevision: wake.reminderRevision + 1 });
}

/** Called under the adapter's owner transaction before recovery writes. */
export function checkUnattendedGuard(tables: Tables, requested: number | undefined) {
  const bound = tables.reminders.guardLimit();
  if (bound !== undefined && requested !== undefined && requested !== bound)
    fail("invalid_config", "Unattended turn limit differs from the saved limit");
}

export function bindUnattendedGuard(tables: Tables, requested: number | undefined) {
  if (requested === undefined || tables.reminders.guardLimit() !== undefined) return;
  tables.reminders.bindGuard(requested);
  const meta = tables.getMeta();
  if (meta.formatVersion === 9) tables.attachments?.advanceBaseFormat(8);
  tables.setMeta({ ...meta, formatVersion: Math.max(meta.formatVersion, 8), revision: meta.revision + 1 });
}

type ReminderDeliveryEvent = { channel: string; event: ReminderChannelEvent };

function migrateRoutineZones(tables: Tables, meta: Meta, events: ReminderDeliveryEvent[]) {
  if (meta.formatVersion < 8) return false;
  const version = resolveRoutineZone("Etc/UTC")!.timezoneVersion;
  let after = 0, changed = false;
  for (;;) {
    const batch = tables.reminders.list(undefined, after, 100);
    for (const saved of batch) {
      const { reminder: row } = saved;
      if (!isRoutine(row) || !row.timezoneVersion || row.timezoneVersion === version) continue;
      if (row.timezoneVersion > version) fail("incompatible", "Routine requires newer timezone data");
      if (row.state === "done" || row.state === "cancelled" || row.state === "expired" || row.timezoneMigration?.targetVersion === version) continue;
      const anchor = Date.parse(row.acceptedAt);
      const schedule = row.remainingCount === undefined ? row.schedule : { ...row.schedule, count: row.remainingCount, until: undefined };
      const prepared = prepareRoutineRow(schedule, row.acceptedAt, anchor, saved.defaultedExpiry ? undefined : row.expiresAfter, saved.processedThrough);
      let reminder: Reminder;
      if (prepared.kind !== "valid") {
        const timezoneMigration = { fromVersion: row.timezoneVersion, targetVersion: version, cause: prepared.kind };
        reminder = { ...row, state: "blocked", nextRunAt: null, blockedReason: "invalid_schedule", timezoneMigration } as Reminder;
        const event = { type: "routine_migration_blocked", reminderId: row.id, ...timezoneMigration } as const;
        tables.reminders.recordDisposition(event);
        events.push({ channel: row.channel, event });
      } else {
        const state = row.timezoneMigration ? "active" : row.state;
        const timezone = "timezone" in prepared.fields.schedule ? prepared.fields.schedule.timezone : undefined;
        const schedule = timezone !== undefined ? { ...row.schedule, timezone } : row.schedule;
        reminder = { ...row, ...prepared.fields, schedule, state,
          blockedReason: row.timezoneMigration ? undefined : row.blockedReason,
          nextRunAt: state === "active" ? prepared.fields.nextRunAt : null, timezoneMigration: undefined } as Reminder;
      }
      tables.reminders.put({ ...saved, reminder, episodeCutoff: undefined, coalescedPending: undefined });
      events.push({ channel: row.channel, event: { type: "reminder_changed", reminder } });
      changed = true;
    }
    if (batch.length < 100) return changed;
    after = batch.at(-1)!.sequence;
  }
}

export function migrateImportedRoutines(tables: Tables) {
  const meta = tables.getMeta();
  if (!migrateRoutineZones(tables, meta, [])) return;
  refreshReminderWake(tables, meta);
  tables.setMeta({ ...meta, revision: meta.revision + 1 });
}

export function recover(tables: Tables, upgrade?: () => void, reminderEvents: ReminderDeliveryEvent[] = []): void {
  tables.transaction(() => {
    if (upgrade) upgrade();
    const meta = tables.getMeta();
    let changed = !!upgrade;
    if (upgrade) meta.formatVersion = 4;
    let abandonedModel = false;
    if (meta.lifecycle !== "suspended") {
      const kept = (turn: TurnRow) => turn.state.status === "suspended"
        && tables.channel(turn.channelId)?.lifecycle === "suspended";
      const live = tables.liveTurns().filter(turn => !kept(turn));
      abandonedModel = live.some(turn => turn.state.status === "running");
      for (const turn of live) tables.putTurn({ ...turn, state: { status: "interrupted",
        reason: "The owning process exited before this turn finished", uncertainCallIds: uncertain(tables, turn) } });
      const reopened = tables.channels().filter(channel => channel.lifecycle === "suspending");
      for (const channel of reopened) tables.putChannel({ ...channel, lifecycle: "open" });
      if (live.length || reopened.length || meta.lifecycle !== "running") { meta.lifecycle = "running"; changed = true; }
    }
    if (meta.formatVersion < 5) {
      const state = emptyModelState();
      for (const entry of tables.entries()) if (entry.message.role === "assistant")
        Object.defineProperty(state.scriptPositions, entry.channelId, { value: (Object.hasOwn(state.scriptPositions, entry.channelId) ? state.scriptPositions[entry.channelId]! : 0) + 1, writable: true, configurable: true, enumerable: true });
      tables.setModelState(state); meta.formatVersion = 5; changed = true;
    } else if (abandonedModel) {
      const state = tables.getModelState() ?? emptyModelState();
      for (const call of state.calls) if (call.outcome === "running") {
        call.outcome = "interrupted"; call.endedAt = new Date().toISOString();
        for (const attempt of call.attempts) if (attempt.outcome === "running") { attempt.outcome = "interrupted"; attempt.endedAt = call.endedAt; }
        changed = true;
      }
      if (changed) tables.setModelState(state);
    }
    if (meta.formatVersion < 6) { meta.formatVersion = 6; changed = true; }
    changed = migrateRoutineZones(tables, meta, reminderEvents) || changed;
    refreshReminderWake(tables, meta);
    if (changed) tables.setMeta({ ...meta, revision: meta.revision + 1 });
  });
}

function unanswered(tables: Tables, turnId: number): string[] {
  const open: string[] = [];
  for (const entry of tables.entriesOfTurn(turnId)) {
    if (entry.message.role === "assistant") for (const call of entry.message.calls) open.push(call.id);
    else if (entry.message.role === "tool") { const at = open.indexOf(entry.message.callId); if (at >= 0) open.splice(at, 1); }
  }
  return open;
}

/** Older states lack dispatch evidence and retain the conservative old rule. */
function uncertain(tables: Tables, turn: TurnRow): string[] {
  const open = unanswered(tables, turn.turnId);
  if (turn.state.status !== "running" && turn.state.status !== "suspended") return open;
  const marked = turn.state.dispatchedCallIds;
  return marked === undefined ? open : open.filter(id => marked.includes(id));
}

/** The contract over any backend. `ownerKey` is the key passed to this open. */
export function createEngine(tables: Tables, ownerKey: string, release: () => void, config?: ManagedConfig, incompatibleViewOnly = false, recoveredReminderEvents: ReminderDeliveryEvent[] = []): SessionStorage {
  let closed = false;
  // This is the config validated at open, not the separately mutable saved copy.
  const ownerSnapshot = config === undefined ? undefined : structuredClone(config);
  const now = () => new Date().toISOString();

  function run<T>(work: (meta: Meta) => T, readOnly = false): StorageResult<T> {
    if (closed) return failure(new Fail("closed", "Storage handle is closed"));
    if (incompatibleViewOnly && !readOnly) return failure(new Fail("incompatible", "Stored policy is not available in the open configuration"));
    try {
      return tables.transaction(() => {
        const meta = tables.getMeta(), before = JSON.stringify(meta);
        const value = work(meta);
        if (!readOnly && JSON.stringify(meta) !== before) refreshReminderWake(tables, meta);
        if (JSON.stringify(meta) !== before) tables.setMeta(meta);
        // Results never alias rows a backend may keep in memory.
        return { ok: true as const, value: structuredClone(value), revision: meta.revision };
      });
    } catch (error) { return failure(error); }
  }
  const seq = (meta: Meta) => ++meta.revision;
  const full = (row: TurnRow): StoredTurn => ({ ...row, itemIds: tables.itemsOfTurn(row.turnId).map(item => item.itemId) });
  function running(turnId: number): TurnRow {
    const turn = tables.turn(turnId) ?? fail("not_found", `Unknown turn: ${turnId}`);
    if (turn.state.status !== "running") fail("invalid_state", `Turn ${turnId} is ${turn.state.status}, not running`);
    return turn;
  }
  function boundaryPending(channelId: string, intake?: IntakeLimit, turnId?: number): StoredItem[] {
    if (!intake) return tables.pendingItems(channelId);
    const already = turnId === undefined ? [] : tables.contextInputs(turnId, tables.contextPreviousResponse(turnId), intake.maxTakenItems);
    const slots = intake.maxTakenItems - already.length;
    if (slots <= 0) return [];
    let bytes = intake.maxTakenTextBytes - already.reduce((sum, row) => sum + (row.textBytes ?? 0), 0);
    const selected: StoredItem[] = [];
    for (const item of tables.pendingItems(channelId, slots)) {
      bytes -= byteLength(item.text);
      // A legacy oversized head advances alone and gets a typed build failure.
      if (bytes < 0 && (selected.length || already.length)) break;
      selected.push(item);
      if (bytes < 0) break;
    }
    return selected;
  }
  function take(meta: Meta, turn: TurnRow, pending: StoredItem[]): TurnTake {
    const items: StoredItem[] = [], entries: TimelineEntry[] = [];
    for (const item of pending) {
      const entry: TimelineEntry = { seq: seq(meta), at: now(), channelId: turn.channelId, turnId: turn.turnId,
        from: item.senderId, kind: item.kind, ...(item.sourceChannelId ? { sourceChannelId: item.sourceChannelId } : {}),
        ...(item.externalSource !== undefined ? { externalSource: item.externalSource } : {}),
        itemId: item.itemId, message: { role: "user", content: item.kind !== "participant_message" ? item.text
          : `Participant: ${JSON.stringify(item.senderId)}\n\n${item.text}` } };
      tables.addEntry(entry);
      const taken: StoredItem = { ...item, milestone: "taken", turnId: turn.turnId, entrySeq: entry.seq };
      tables.putItem(taken);
      items.push(taken); entries.push(entry);
    }
    return { turn: full(turn), items, entries };
  }
  function interrupt(turn: TurnRow, status: "failed" | "interrupted", reason: string): TurnRow {
    const ended: TurnRow = { ...turn, state: { status, reason, uncertainCallIds: uncertain(tables, turn) } };
    tables.putTurn(ended);
    finishModels(turn.turnId);
    settle(turn.channelId);
    return ended;
  }
  /** The channel's running turn just left `running` (end or checkpoint): a
   * `suspending` channel becomes `suspended` in this same transaction. */
  function settle(channelId: string): void {
    const channel = tables.channel(channelId);
    if (channel?.lifecycle === "suspending") tables.putChannel({ ...channel, lifecycle: "suspended" });
  }
  const channelOf = (channelId: unknown): ChannelRow => {
    const channel = typeof channelId === "string" ? tables.channel(channelId) : undefined;
    if (!channel) return fail("not_found", `Unknown channel: ${String(channelId)}`);
    if (channel.lifecycle === "retired") return fail("channel_retired", `Channel ${channel.channelId} is retired`);
    return channel;
  };
  const view = (channel: ChannelRow): StoredChannel => {
    const spoke = new Set(tables.entries().filter(entry => entry.channelId === channel.channelId && entry.kind === "participant_message").map(entry => entry.from));
    return { ...channel, participantIds: [...spoke] };
  };
  const legacy = "__legacy_allow";
  const activeConfig = ownerSnapshot ?? { version: 1 as const, system: "", model: { protocol: "scripted" as const, script: "legacy" }, defaultPolicy: legacy,
    policies: { [legacy]: { fallback: "allow" as const, tools: {} } } };
  const requireCompatible = () => {
    if (!referencesCompatible(tables, activeConfig)) fail("incompatible", "A stored policy no longer exists");
  };
  const turnFingerprint = (turn: TurnRow) => fingerprint(activeConfig, contributingPolicies(tables.itemsOfTurn(turn.turnId)
    .map(item => item.policy ?? { resolved: legacy, inherited: [] })));
  const compatible = (turn: TurnRow) => {
    try { return turn.compatibilityKey === ownerKey && turn.state.status === "suspended" && turn.state.checkpoint.policyFingerprint === turnFingerprint(turn); }
    catch { return false; }
  };
  const resolve = (explicit?: string | null, channel?: string) => {
    const selected = explicit ?? channel ?? ownerSnapshot?.defaultPolicy ?? legacy;
    if (ownerSnapshot && !Object.hasOwn(ownerSnapshot.policies, selected)) fail("invalid_policy", `Unknown policy: ${selected}`);
    if (!ownerSnapshot && selected !== legacy) fail("invalid_policy", `Unknown policy: ${selected}`);
    return selected;
  };

  const modelCall = (state: ModelState, id: string) => state.calls.find(call => call.callId === id) ?? fail("not_found", `Unknown model call: ${id}`);
  const activeAttempt = (state: ModelState, id: string, attemptId: string) => {
    const call = modelCall(state, id); running(Number(call.turnId));
    if (call.outcome !== "running") fail("invalid_state", "Model call has ended");
    const attempt = call.attempts.find(value => value.attemptId === attemptId);
    if (!attempt || attempt.outcome !== "running") return fail("invalid_state", "Model attempt has ended or is unknown");
    return { call, attempt };
  };
  const finishModels = (turnId: number) => {
    const state = tables.getModelState() ?? emptyModelState(); const changed: ModelCallSummary[] = [];
    for (const call of state.calls) if (call.turnId === String(turnId) && call.outcome === "running") {
      call.outcome = "interrupted"; call.endedAt = now(); changed.push(call);
      for (const attempt of call.attempts) if (attempt.outcome === "running") { attempt.outcome = "interrupted"; attempt.endedAt = call.endedAt; }
    }
    if (changed.length) tables.setModelState(state, changed);
  };
  const accept = (meta: Meta, input: AcceptItem, maxInputBytes?: number) => {
      const external = input?.kind === "external_notice";
      if (!external) requireCompatible();
      if (external && (!text(input.itemId) || !text(input.channelId) || !text(input.text)
        || (input.externalSource !== undefined && !text(input.externalSource))
        || !Array.isArray(input.inheritedPolicyNames) || !Array.from(input.inheritedPolicyNames).every(text)
        || input.sourceChannelId !== undefined || input.sourceTurnId !== undefined || input.explicitPolicy !== undefined))
        fail("invalid_input", "Invalid external notice");
      const shaped = !!input && typeof input === "object"
        && [input.kind, input.channelId, input.senderId, input.text].every(value => typeof value === "string")
        && (input.sourceChannelId === undefined || typeof input.sourceChannelId === "string")
        && (input.explicitPolicy === undefined || input.explicitPolicy === null || typeof input.explicitPolicy === "string");
      if (shaped && typeof input.itemId === "string") {
        const known = tables.item(input.itemId);
        if (known) {
          if (known.signature !== signatureOf(input)) fail("item_conflict", `Item ID ${input.itemId} already identifies different input`);
          return { item: known, duplicate: true };
        }
      }
      const notice = shaped && input.kind === "channel_notice";
      if (!shaped || !(notice || external || input.kind === "participant_message") || ![input.channelId, input.senderId, input.text].every(text)
        || (input.itemId !== undefined && !text(input.itemId))
        || (notice ? !text(input.sourceChannelId) : input.sourceChannelId !== undefined))
        fail("invalid_input", "Item needs kind, channelId, senderId and text; a notice also needs sourceChannelId");
      if (maxInputBytes !== undefined && typeof input?.text === "string" && byteLength(input.text) > maxInputBytes)
        fail("invalid_input", `Input exceeds the ${maxInputBytes}-byte UTF-8 limit`);
      if (external) {
        if (incompatibleViewOnly) fail("incompatible", "Stored policy is not available in the open configuration");
        requireCompatible();
        if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; new work is not admitted`);
        const channel = channelOf(input.channelId);
        if (channel.lifecycle !== "open") fail("channel_suspended", `Channel ${channel.channelId} is ${channel.lifecycle}`);
      }
      const target = tables.channel(input.channelId);
      if (notice && input.explicitPolicy != null) fail("invalid_input", "Notices cannot override policy");
      if (notice && ownerSnapshot && input.sourceTurnId === undefined) fail("invalid_input", "A notice needs its executing source turn");
      const resolved = resolve(input.explicitPolicy, target?.policy);
      let inherited: string[] = external ? [...new Set(input.inheritedPolicyNames!)].sort() : [];
      if (external) for (const name of inherited)
        if (name === "__legacy_allow" || !Object.hasOwn(activeConfig.policies, name)) fail("invalid_policy", `Unknown or reserved policy: ${name}`);
      if (notice && input.sourceTurnId !== undefined) {
        const source = tables.turn(input.sourceTurnId);
        if (!source || source.channelId !== input.sourceChannelId || source.state.status !== "running") fail("invalid_input", "Invalid notice source turn");
        inherited = contributingPolicies(tables.itemsOfTurn(input.sourceTurnId).map(item => item.policy ?? { resolved: legacy, inherited: [] }));
      }
      if (notice && !target) fail("not_found", `Unknown channel: ${input.channelId}`);
      if (target?.lifecycle === "retired") fail("channel_retired", `Channel ${input.channelId} is retired`);
      if (meta.lifecycle === "suspended" || (meta.lifecycle === "suspending" && !notice))
        fail("not_running", `Session is ${meta.lifecycle}; new work is not admitted`);
      if (target && target.lifecycle !== "open") fail("channel_suspended", `Channel ${input.channelId} is ${target.lifecycle}; new work is not admitted`);
      let itemId = input.itemId;
      if (itemId === undefined) itemId = `auto:${meta.nextItemNumber++}`;
      else {
        const auto = AUTO.exec(itemId);
        if (auto) {
          const n = Number(auto[1]);
          if (!Number.isSafeInteger(n + 1)) fail("invalid_input", "Reserved item ID is out of range");
          if (n >= meta.nextItemNumber) meta.nextItemNumber = n + 1;
        }
      }
      const item: StoredItem = { itemId, kind: input.kind, channelId: input.channelId, senderId: external ? input.externalSource ?? "host" : input.senderId,
        ...(external ? { inheritedPolicyNames: inherited, ...(input.externalSource === undefined ? {} : { externalSource: input.externalSource }) } : {}),
        ...(notice ? { sourceChannelId: input.sourceChannelId } : {}), ...(input.explicitPolicy == null ? {} : { explicitPolicy: input.explicitPolicy }), text: input.text,
        signature: signatureOf(input), policy: { ...(input.explicitPolicy == null ? {} : { explicit: input.explicitPolicy }), resolved, inherited },
        acceptedSeq: seq(meta), acceptedAt: now(), milestone: "received" };
      if (!notice && !external) {
        if (!target) tables.putChannel({ channelId: item.channelId, lifecycle: "open" });
        tables.addParticipant(item.senderId);
      }
      tables.putItem(item);
      return { item, duplicate: false };
  };
  const reminders = tables.reminders;
  const activateReminders = (meta: Meta) => {
    if (meta.formatVersion < 7 || (meta.formatVersion === 9 && (tables.attachments?.baseFormat() ?? 0) < 7)) {
      reminders.activate();
      if (meta.formatVersion === 9) tables.attachments?.advanceBaseFormat(7);
      else meta.formatVersion = 7;
    }
  };
  const putReminder = (meta: Meta, reminder: Reminder, defaultedExpiry?: boolean, original?: string) => {
    activateReminders(meta);
    const existing = reminders.get(reminder.id);
    const revision = seq(meta);
    reminders.put({ ...existing, sequence: existing?.sequence ?? revision, reminder, defaultedExpiry: defaultedExpiry ?? existing?.defaultedExpiry ?? false, original: existing?.original ?? original });
  };
  const validReminderPolicies = (names: readonly string[]) =>
    names.every(name => name !== legacy && Object.hasOwn(activeConfig.policies, name));
  function unblockReminders(meta: Meta, channelId?: string) {
    const unblocked: Reminder[] = [];
    let after = 0;
    for (;;) {
      const batch = reminders.blocked(channelId, after, 100);
      for (const { reminder } of batch) {
        if (tables.channel(reminder.channel)?.lifecycle !== "open" || !validReminderPolicies(reminder.policyNames)) continue;
        if (isRoutine(reminder)) continue;
        const { blockedReason: _block, ...fields } = reminder;
        const active: OneOffReminder = { ...fields, state: "active", nextRunAt: reminder.schedule.at };
        putReminder(meta, active);
        unblocked.push(active);
      }
      if (batch.length < 100) return unblocked.length ? { unblockedReminders: unblocked } : {};
      after = batch.at(-1)!.sequence;
    }
  }
  return {
    startCall: (turnId, itemIds) => run(meta => {
      if (!/^[1-9]\d*$/.test(turnId) || !Number.isSafeInteger(Number(turnId))) fail("invalid_input", "Invalid turn ID");
      const turn = running(Number(turnId));
      if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length || itemIds.some(id => tables.item(id)?.turnId !== turn.turnId))
        fail("invalid_input", "Model call inputs must be taken items of this turn");
      const state = tables.getModelState() ?? emptyModelState();
      if (state.calls.some(call => call.turnId === turnId && call.outcome === "running")) fail("invalid_state", "Turn already has a running model call");
      const id = String(state.nextCall++), call: ModelCallSummary = { callId: id, turnId, channel: turn.channelId, messageId: `model:${id}`,
        startedAt: now(), outcome: "running", attempts: [] };
      state.calls.push(call); state.itemIds[id] = [...itemIds]; tables.setModelState(state, [call]); seq(meta); return call;
    }),
    startAttempt: (id, scripted) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id); running(Number(call.turnId));
      if (call.outcome !== "running" || call.attempts.length >= 2 || call.attempts.some(a => a.outcome === "running")) fail("invalid_state", "Cannot start another model attempt");
      const ordinal = call.attempts.length, step = Object.hasOwn(state.scriptPositions, call.channel) ? state.scriptPositions[call.channel]! : 0;
      const attempt: ModelCallSummary["attempts"][number] = { attemptId: `${id}:${ordinal}`, ordinal, startedAt: now(), outcome: "running", ...(ordinal ? { retryReason: call.attempts[ordinal - 1]?.outcome } : {}), ...(scripted ? { scriptStep: step } : {}) };
      if (scripted) Object.defineProperty(state.scriptPositions, call.channel, { value: step + 1, writable: true, configurable: true, enumerable: true });
      call.attempts.push(attempt); tables.setModelState(state, [call]); seq(meta); return attempt;
    }),
    confirm: (id, attemptId, milestone) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(); activeAttempt(state, id, attemptId);
      if (milestone !== "delivered" && milestone !== "seen") fail("invalid_input", "Invalid receipt");
      const advanced = (state.itemIds[id] ?? []).map(itemId => tables.item(itemId)!).filter(item => RANK[item.milestone] < RANK[milestone]);
      for (const item of advanced) tables.putItem({ ...item, milestone });
      if (advanced.length) seq(meta); return advanced.map(item => item.itemId);
    }),
    recordProviderRequestId: (id, attemptId, requestId) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), { call, attempt } = activeAttempt(state, id, attemptId);
      if (!text(requestId)) fail("invalid_input", "Invalid provider request ID");
      if (!attempt.providerRequestId) { attempt.providerRequestId = requestId; tables.setModelState(state, [call]); seq(meta); }
    }),
    recordUsage: (id, attemptId, usage) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id);
      const attempt = call.attempts.find(value => value.attemptId === attemptId);
      if (!attempt) return fail("not_found", "Unknown model attempt");
      if (call.outcome !== "running" || attempt.outcome !== "running" || tables.turn(Number(call.turnId))?.state.status !== "running") return;
      if (!usage || typeof usage !== "object" || Object.keys(usage).some(key => !["inputTokens", "outputTokens", "totalTokens"].includes(key))
        || Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) fail("invalid_input", "Invalid provider usage");
      attempt.usage = structuredClone(usage); tables.setModelState(state, [call]); seq(meta);
    }),
    finishAttempt: (id, attemptId, outcome, requestId) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), { call, attempt } = activeAttempt(state, id, attemptId);
      if (!["transient_failure", "invalid_request", "invalid_config", "provider_failure", "incomplete", "output_limit", "timeout", "interrupted"].includes(outcome) || (requestId !== undefined && !text(requestId))) fail("invalid_input", "Invalid attempt outcome or provider ID");
      attempt.outcome = outcome; attempt.endedAt = now(); if (!attempt.providerRequestId && requestId) attempt.providerRequestId = requestId;
      tables.setModelState(state, [call]); seq(meta);
    }),
    commitResponse: (id, attemptId, response, requestId) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), { call, attempt } = activeAttempt(state, id, attemptId), turn = running(Number(call.turnId));
      if (requestId !== undefined && !text(requestId)) fail("invalid_input", "Invalid provider request ID");
      if (!response || !((response.stopReason === "complete" && response.calls?.length === 0) || (response.stopReason === "tool_calls" && response.calls?.length > 0))) fail("invalid_input", "Invalid response stop reason");
      const { stopReason: _stopReason, ...raw } = response, message = checkMessage(raw);
      if (message.role !== "assistant") return fail("invalid_input", "Expected assistant response");
      if (unanswered(tables, turn.turnId).length) fail("invalid_state", "Earlier tool calls have no result");
      const used = new Set(tables.entriesOfTurn(turn.turnId).flatMap(entry => entry.message.role === "assistant" ? entry.message.calls.map(c => c.id) : []));
      for (const tool of message.calls) {
        if (used.has(tool.id)) fail("invalid_input", "Duplicate tool call ID"); used.add(tool.id);
        try { const args = JSON.parse(tool.arguments); if (!args || typeof args !== "object" || Array.isArray(args)) fail("invalid_input", "Invalid tool arguments"); }
        catch (error) { if (error instanceof Fail) throw error; fail("invalid_input", "Invalid tool arguments"); }
      }
      if (message.calls.length && turn.state.status === "running" && turn.state.dispatchedCallIds === undefined) tables.putTurn({ ...turn, state: { ...turn.state, dispatchedCallIds: [] } });
      const entry: TimelineEntry = { seq: seq(meta), at: now(), channelId: turn.channelId, turnId: turn.turnId, from: "agent", message };
      tables.addEntry({ ...entry, messageId: call.messageId }); state.entryIds[String(entry.seq)] = call.messageId; call.outcome = "succeeded"; call.endedAt = now();
      attempt.outcome = "succeeded"; attempt.endedAt = call.endedAt; if (!attempt.providerRequestId && requestId) attempt.providerRequestId = requestId;
      tables.setModelState(state, [call]); return { ...entry, messageId: call.messageId };
    }),
    finishCall: (id, outcome) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id); running(Number(call.turnId));
      if (call.outcome !== "running" || call.attempts.some(a => a.outcome === "running")) fail("invalid_state", "Cannot finish model call");
      if (!["failed", "incomplete", "output_limit", "timeout", "interrupted"].includes(outcome)) fail("invalid_input", "Invalid call outcome");
      call.outcome = outcome; call.endedAt = now(); tables.setModelState(state, [call]); seq(meta);
    }),
    readCalls: (after, limit = 100) => run(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Invalid model call page size");
      const rows = tables.modelCallPage(after, limit + 1);
      const calls = rows.slice(0, limit);
      return { calls, ...(rows.length > limit ? { next: calls.at(-1)!.callId } : {}) };
    }, true),
    acceptItem: (input, maxInputBytes) => run(meta => accept(meta, input, maxInputBytes), input?.kind === "external_notice"),

    changeReminder: (change, wallTime) => run(meta => {
      requireCompatible();
      const routineSchedule = change.op !== "cancel" && change.payload.schedule !== undefined && change.payload.schedule.at === undefined;
      const replacing = change.op === "update" && change.payload.schedule !== undefined;
      return applyReminderChange({
        guardEnabled: () => reminders.guardLimit() !== undefined,
        activeRoutines: channel => reminders.activeRoutines(channel),
        processedThrough: id => reminders.get(id)?.processedThrough,
        proofExhausted: () => fail("storage_failure", "Routine calendar proof budget exhausted"),
        receipt: reminders.receipt, highWater: reminders.highWater, originalCreate: reminders.originalCreate,
        defaultedExpiry: id => reminders.get(id)?.defaultedExpiry ?? false,
        get: id => reminders.get(id)?.reminder, put: (reminder, defaulted, original) => {
          putReminder(meta, reminder, defaulted, original);
          if (replacing && isRoutine(reminder)) {
            const row = reminders.get(reminder.id)!;
            if (row.episodeCutoff !== undefined || row.coalescedPending !== undefined)
              reminders.put({ ...row, episodeCutoff: undefined, coalescedPending: undefined });
          }
        },
        saveReceipt(receipt) {
          activateReminders(meta);
          if (routineSchedule) {
            if (meta.formatVersion === 9) tables.attachments?.advanceBaseFormat(8);
            else meta.formatVersion = 8;
          }
          reminders.saveReceipt(receipt);
          seq(meta);
        },
        channelStatus: channel => tables.channel(channel)?.lifecycle, validPolicies: validReminderPolicies,
      }, change, wallTime);
    }),
    scheduleAgentReminder: (turnId, invocationId, schedule, body, inherited, grace, wallTime, delivery) => run(meta => {
      requireCompatible();
      const turn = running(turnId);
      const id = `agent-reminder:${invocationId}`;
      const existing = reminders.get(id)?.reminder;
      if (existing) return { reminder: existing, created: false };
      const anchor = new Date(wallTime).toISOString();
      const policyNames = [...new Set(inherited.filter(name => name !== legacy))].sort();
      if (!validReminderPolicies(policyNames)) return fail("invalid_policy", "Unknown reminder policy");
      const creatorId = tables.itemsOfTurn(turnId).find(item => item.kind === "participant_message")?.senderId;
      if ("every" in schedule || "cron" in schedule) {
        if (reminders.guardLimit() === undefined) return fail("invalid_state", "An unattended turn guard is required");
        if (reminders.activeRoutines(turn.channelId) >= 20) return fail("invalid_input", "Active routine limit reached");
        const prepared = prepareRoutineRow(schedule, anchor, wallTime, grace);
        if (prepared.kind === "proof_budget") return fail("storage_failure", "Routine calendar proof budget exhausted");
        if (prepared.kind !== "valid") return fail("invalid_input", "Invalid routine schedule");
        const routine = { ...prepared.fields, id, channel: turn.channelId, createdBy: "agent", creatorId, policyNames, text: body,
          state: "active", missedRuns: delivery?.missedRuns ?? "coalesce", overlap: delivery?.overlap ?? "skip" } as Reminder;
        putReminder(meta, routine, grace === undefined);
        return { reminder: routine, created: true };
      }
      const at = resolveAgentReminder(schedule, wallTime);
      const timing = at && normalizeReminderSchedule(at, anchor, grace, wallTime);
      if (!timing) return fail("invalid_input", "Invalid reminder schedule");
      const reminder: OneOffReminder = { ...timing, id, channel: turn.channelId, createdBy: "agent",
        ...(creatorId === undefined ? {} : { creatorId }), policyNames, text: body, state: "active", nextRunAt: timing.schedule.at };
      putReminder(meta, reminder, grace === undefined);
      return { reminder, created: true };
    }),
    cancelAgentReminder: (turnId, id) => run(meta => {
      requireCompatible();
      const turn = running(turnId), reminder = reminders.get(id)?.reminder;
      if (!reminder || reminder.channel !== turn.channelId) return fail("not_found", "Unknown reminder");
      const changed = !["done", "cancelled", "expired"].includes(reminder.state);
      if (changed) putReminder(meta, { ...reminder, state: "cancelled", nextRunAt: null });
      return { id, alreadyQueued: reminder.noticeId !== undefined, changed };
    }),
    readReminder: id => run(() => reminders.get(id)?.reminder, true),
    listReminders: ({ channel, after, limit = 50 }) => run(meta => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Invalid reminder list limit");
      const revision = reminders.listingRevision();
      const cursor = (position: number) => Buffer.from(JSON.stringify([meta.sessionId, channel ?? null, revision, position])).toString("base64url");
      let position = 0;
      if (after !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(after, "base64url").toString());
          position = parsed[3];
          if (!Number.isSafeInteger(position) || position < 1 || cursor(position) !== after) fail("invalid_cursor", "Reminder listing cursor expired");
        } catch { fail("invalid_cursor", "Invalid or stale reminder listing cursor"); }
      }
      const rows = reminders.list(channel, position, limit + 1);
      const page = rows.slice(0, limit);
      return { reminders: page.map(row => row.reminder), ...(rows.length > limit ? { next: cursor(page.at(-1)!.sequence) } : {}) };
    }, true),
    reminderWake: () => run(() => reminders.wake(), true),
    fireDueReminders: wallTime => {
      const result = run(meta => {
      requireCompatible();
      const events: ReminderDeliveryEvent[] = [...recoveredReminderEvents];
      if (meta.lifecycle !== "running") return events;
      const firedAt = new Date(wallTime).toISOString();
      const evaluate = createRoutineEvaluator();
      const held = routineHeldChannels(tables, meta);
      for (let attempts = 0; attempts < 100; attempts++) {
        const saved = reminders.eligible(firedAt, 1, held)[0];
        if (!saved) break;
        const { reminder } = saved;
        if (isRoutine(reminder)) {
          const { channel, id } = reminder;
          if (!validReminderPolicies(reminder.policyNames)) {
            const blocked: Reminder = { ...reminder, state: "blocked", nextRunAt: null, blockedReason: "invalid_policy" };
            putReminder(meta, blocked);
            events.push({ channel, event: { type: "reminder_changed", reminder: blocked } });
            continue;
          }
          const limit = reminders.guardLimit();
          if (limit === undefined || !unattendedAdmission(limit, reminders.guardSpent(channel),
            boundaryPending(channel, SESSION_INTAKE_LIMITS).some(item => item.kind === "participant_message")).eligible) break;
          const grace = saved.defaultedExpiry ? undefined : reminder.expiresAfter;
          const schedule = reminder.remainingCount === undefined ? reminder.schedule
            : { ...reminder.schedule, count: reminder.remainingCount, until: undefined };
          const calendar = evaluate(schedule, reminder.acceptedAt, reminder.timezoneVersion, saved.processedThrough);
          if (!calendar) {
            const blocked: Reminder = { ...reminder, state: "blocked", nextRunAt: null, blockedReason: "invalid_schedule" };
            putReminder(meta, blocked);
            events.push({ channel, event: { type: "reminder_changed", reminder: blocked } });
            continue;
          }
          const cutoff = saved.episodeCutoff ?? wallTime;
          const step = planRoutineEpisode(calendar, 0, cutoff, grace, reminder.missedRuns)[0];
          if (!step) break;
          const overlapping = reminder.overlap === "skip" && tables.hasOpenRoutineNotice(channel, `reminder:${id}`);
          const partial = saved.coalescedPending ?? 0;
          const effective = step.kind === "enqueue" && partial ? { ...step, represented: step.represented + partial } : step;
          const advanced = advanceRoutine(reminder, calendar, effective, wallTime, grace, overlapping);
          if (advanced.disposition) {
            reminders.recordDisposition(advanced.disposition);
            events.push({ channel, event: advanced.disposition });
          }
          if (advanced.notice) {
            const { noticeId, occurrenceId, scheduledAt, text } = advanced.notice;
            accept(meta, { kind: "external_notice", itemId: noticeId, channelId: channel, senderId: `reminder:${id}`,
              externalSource: `reminder:${id}`, text, inheritedPolicyNames: reminder.policyNames });
            events.push({ channel, event: { type: "reminder_fired", reminderId: id, occurrenceId, scheduledAt, firedAt, noticeId } });
          }
          seq(meta);
          const nextDue = advanced.reminder.nextRunAt;
          reminders.put({ ...saved, reminder: advanced.reminder, processedThrough: calendar.at(step.last),
            episodeCutoff: nextDue !== null && Date.parse(nextDue) <= cutoff ? cutoff : undefined,
            coalescedPending: step.kind === "coalesced" ? partial + step.last - step.first + 1
              : step.kind === "enqueue" ? undefined : saved.coalescedPending });
          events.push({ channel, event: { type: "reminder_changed", reminder: advanced.reminder } });
          continue;
        }
        const { id, channel, schedule } = reminder;
        const scheduledAt = schedule.at, occurrenceId = `reminder:${id}:${scheduledAt}`;
        if (reminder.expiresAt !== null && reminder.expiresAt <= firedAt) {
          putReminder(meta, { ...reminder, state: "expired", nextRunAt: null, lastOccurrenceId: occurrenceId });
          events.push({ channel, event: { type: "reminder_expired", reminderId: id, occurrenceId, scheduledAt, expiredAt: firedAt } });
          continue;
        }
        if (!validReminderPolicies(reminder.policyNames)) {
          const blocked: OneOffReminder = { ...reminder, state: "blocked", nextRunAt: null, blockedReason: "invalid_policy" };
          putReminder(meta, blocked);
          events.push({ channel, event: { type: "reminder_changed", reminder: blocked } });
          continue;
        }
        const noticeId = `reminder-notice:${id}:${scheduledAt}`;
        accept(meta, { kind: "external_notice", itemId: noticeId, channelId: channel, senderId: `reminder:${id}`,
          externalSource: `reminder:${id}`, text: reminder.text, inheritedPolicyNames: reminder.policyNames });
        putReminder(meta, { ...reminder, state: "done", nextRunAt: null, lastOccurrenceId: occurrenceId, lastRunAt: firedAt, noticeId });
        events.push({ channel, event: { type: "reminder_fired", reminderId: id, occurrenceId, scheduledAt, firedAt, noticeId } });
      }
      return events;
      });
      if (result.ok) recoveredReminderEvents.length = 0;
      return result;
    },

    beginTurn: (channelId, intake) => run(meta => {
      requireCompatible();
      if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; no turn can begin`);
      const channel = channelOf(channelId);
      if (channel.lifecycle !== "open") fail("channel_suspended", `Channel ${channel.channelId} is ${channel.lifecycle}; no turn can begin`);
      if (tables.liveTurn(channel.channelId)) return null;
      const pending = boundaryPending(channelId, intake);
      if (!pending.length) return null;
      const limit = meta.formatVersion >= 8 ? reminders.guardLimit() : undefined;
      if (limit !== undefined) {
        const spent = reminders.guardSpent(channelId);
        const admission = unattendedAdmission(limit, spent, pending.some(item => item.kind === "participant_message"));
        if (!admission.eligible) return null;
        if (admission.nextSpent !== spent) reminders.setGuardSpent(channelId, admission.nextSpent);
      }
      const turn: TurnRow = { turnId: meta.nextTurnId++, channelId, startedSeq: seq(meta), startedAt: now(),
        compatibilityKey: ownerKey, state: { status: "running" } };
      tables.putTurn(turn);
      return take(meta, turn, pending);
    }),

    takePending: (turnId, intake) => run(meta => {
      const turn = running(turnId);
      if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; input stays pending`);
      const channel = channelOf(turn.channelId);
      if (channel.lifecycle !== "open") fail("channel_suspended", `Channel ${channel.channelId} is ${channel.lifecycle}; input stays pending`);
      return take(meta, turn, boundaryPending(turn.channelId, intake, turnId));
    }),

    appendMessage: (turnId, raw) => run(meta => {
      const turn = running(turnId), message = checkMessage(raw), open = unanswered(tables, turnId);
      if (message.role === "assistant") {
        if (open.length) fail("invalid_state", "Earlier tool calls in this turn have no recorded result");
        const used = new Set<string>();
        for (const entry of tables.entriesOfTurn(turnId))
          if (entry.message.role === "assistant") for (const call of entry.message.calls) used.add(call.id);
        for (const call of message.calls) {
          if (used.has(call.id)) fail("invalid_input", `Duplicate tool call ID: ${call.id}`);
          used.add(call.id);
        }
        if (message.calls.length && turn.state.status === "running" && turn.state.dispatchedCallIds === undefined)
          tables.putTurn({ ...turn, state: { ...turn.state, dispatchedCallIds: [] } });
      } else if (!open.includes(message.callId)) fail("invalid_input", `No unanswered call ${message.callId} in this turn`);
      const entry: TimelineEntry = { seq: seq(meta), at: now(), channelId: turn.channelId, turnId,
        from: message.role === "tool" ? "tool" : "agent", message: structuredClone(message) };
      tables.addEntry(entry);
      return entry;
    }),

    markToolDispatched: (turnId, callId) => run(meta => {
      const turn = running(turnId);
      const state = turn.state.status === "running" ? turn.state : fail("invalid_state", "Turn is not running");
      if (!text(callId) || !unanswered(tables, turnId).includes(callId)
        || state.dispatchedCallIds?.includes(callId)) fail("invalid_state", "Call is not an undispatched outstanding call of this turn");
      tables.putTurn({ ...turn, state: { ...state, dispatchedCallIds: [...(state.dispatchedCallIds ?? []), callId] } });
      seq(meta);
    }),

    confirmReceipts: (turnId, milestone) => run(meta => {
      running(turnId);
      if (milestone !== "delivered" && milestone !== "seen") fail("invalid_input", "Receipt must be delivered or seen");
      const advanced = tables.itemsOfTurn(turnId).filter(item => RANK[item.milestone] < RANK[milestone])
        .map(item => ({ ...item, milestone }));
      for (const item of advanced) tables.putItem(item);
      if (advanced.length) seq(meta);
      return advanced;
    }),

    finishTurn: (turnId, outcome) => run(meta => {
      const turn = running(turnId);
      if (outcome?.status === "completed") {
        const last = tables.entriesOfTurn(turnId).at(-1)?.message;
        if (!last || last.role !== "assistant" || last.calls.length)
          fail("invalid_state", "Completion needs a final assistant response without tool calls");
        const pending = tables.pendingCount(turn.channelId);
        if (pending) return { finished: false as const, pending };
        const done: TurnRow = { ...turn, state: { status: "completed" } };
        tables.putTurn(done); settle(turn.channelId); seq(meta);
        return { finished: true as const, turn: full(done) };
      }
      if (!outcome || (outcome.status !== "failed" && outcome.status !== "interrupted") || !text(outcome.reason))
        fail("invalid_input", "Outcome must be completed, or failed/interrupted with a reason");
      const ended = interrupt(turn, outcome.status as "failed" | "interrupted", (outcome as { reason: string }).reason);
      seq(meta);
      return { finished: true as const, turn: full(ended) };
    }),

    checkpointTurn: turnId => run(meta => {
      const turn = running(turnId);
      if (meta.lifecycle !== "suspending" && tables.channel(turn.channelId)?.lifecycle !== "suspending")
        fail("invalid_state", "Checkpoints are saved only while the session or the channel is suspending");
      if (unanswered(tables, turnId).length) fail("invalid_state", "A tool call in this turn has no recorded result");
      const last = tables.entriesOfTurn(turnId).at(-1);
      if (last?.message.role === "assistant" && !last.message.calls.length && !tables.pendingItems(turn.channelId).length)
        fail("invalid_state", "This turn is finished; complete it instead of checkpointing");
      const saved: TurnRow = { ...turn, state: { status: "suspended", ...(turn.state.status === "running" && turn.state.dispatchedCallIds !== undefined ? { dispatchedCallIds: turn.state.dispatchedCallIds } : {}),
        checkpoint: { nextStep: "inference", afterSeq: last?.seq ?? turn.startedSeq, policyFingerprint: turnFingerprint(turn) } } };
      tables.putTurn(saved); settle(turn.channelId); seq(meta);
      return full(saved);
    }),

    beginSuspend: () => run(meta => {
      if (meta.lifecycle === "running") { meta.lifecycle = "suspending"; seq(meta); }
      return session(meta);
    }),

    completeSuspend: () => run(meta => {
      if (meta.lifecycle === "suspended") return session(meta);
      if (meta.lifecycle !== "suspending") fail("invalid_state", "Session is not suspending");
      if (tables.turns().some(turn => turn.state.status === "running")) fail("invalid_state", "A turn is still running");
      meta.lifecycle = "suspended"; seq(meta);
      return session(meta);
    }),

    resume: () => run(meta => {
      requireCompatible();
      if (meta.lifecycle === "running") return { session: session(meta), turns: [], ...unblockReminders(meta) };
      if (meta.lifecycle !== "suspended") fail("invalid_state", "Session is still suspending");
      // Turns of individually suspended (or retired) channels are not ours to resume.
      const saved = tables.turns().filter(turn => turn.state.status === "suspended"
        && ["open", "suspending"].includes(tables.channel(turn.channelId)?.lifecycle ?? "retired"));
      const foreign = saved.find(turn => !compatible(turn));
      if (foreign) fail("incompatible", `Turn ${foreign.turnId} was checkpointed under a different configuration`);
      const turns = saved.map(turn => { const live: TurnRow = { ...turn, state: { status: "running", ...(turn.state.status === "suspended" && turn.state.dispatchedCallIds !== undefined ? { dispatchedCallIds: turn.state.dispatchedCallIds } : {}) } }; tables.putTurn(live); return full(live); });
      meta.lifecycle = "running"; seq(meta);
      return { session: session(meta), turns, ...unblockReminders(meta) };
    }),

    interruptActive: reason => run(meta => {
      if (!text(reason)) fail("invalid_input", "Interruption needs a reason");
      if (meta.lifecycle === "suspended") return [];
      const suspending = meta.lifecycle === "suspending";
      const held = (turn: TurnRow) => tables.channel(turn.channelId)?.lifecycle === "suspended";
      // A `suspending` channel never committed: it returns to `open`, not to
      // `suspended`, so settle it only after the turns below have ended.
      const reopened = tables.channels().filter(channel => channel.lifecycle === "suspending");
      for (const channel of reopened) tables.putChannel({ ...channel, lifecycle: "open" });
      const ended = tables.turns().filter(turn => turn.state.status === "running" || (suspending && turn.state.status === "suspended" && !held(turn)))
        .map(turn => full(interrupt(turn, "interrupted", reason)));
      if (suspending) meta.lifecycle = "running";
      if (ended.length || suspending || reopened.length) seq(meta);
      return ended;
    }),

    setToolRevoked: (name, revoked) => run(meta => {
      if (!text(name) || typeof revoked !== "boolean") fail("invalid_input", "Tool revocation needs a name and a boolean");
      const current = tables.getRevokedTools() ?? [];
      if (current.includes(name) === revoked) return current;
      const next = revoked ? [...current, name].sort() : current.filter(value => value !== name);
      tables.setRevokedTools(next); seq(meta);
      return next;
    }),

    createChannel: input => run(meta => {
      if (!input || typeof input !== "object" || !text(input.channelId)) fail("invalid_input", "Channel needs a channelId");
      const name = input.displayName === undefined ? undefined : cleanName(input.displayName);
      if (input.policy !== undefined) resolve(input.policy);
      const known = tables.channel(input.channelId);
      if (known?.lifecycle === "retired") fail("channel_retired", `Channel ${input.channelId} is retired`);
      if (known) {
        if (known.displayName !== name || known.policy !== input.policy) fail("already_exists", `Channel ${input.channelId} already exists with different settings`);
        return { channel: view(known), created: false };
      }
      const row: ChannelRow = { channelId: input.channelId, ...(name === undefined ? {} : { displayName: name }), ...(input.policy === undefined ? {} : { policy: input.policy }), lifecycle: "open" };
      tables.putChannel(row); seq(meta);
      return { channel: view(row), created: true };
    }),

    editChannel: (channelId, displayName, policy) => run(meta => {
      const channel = channelOf(channelId);
      const name = displayName === null ? undefined : cleanName(displayName);
      if (policy != null) resolve(policy);
      const nextPolicy = policy === undefined ? channel.policy : policy ?? undefined;
      if (channel.displayName === name && channel.policy === nextPolicy) return view(channel);
      const { displayName: _old, policy: _previous, ...rest } = channel;
      const row: ChannelRow = { ...rest, ...(name === undefined ? {} : { displayName: name }), ...(nextPolicy === undefined ? {} : { policy: nextPolicy }) };
      tables.putChannel(row); seq(meta);
      return view(row);
    }),

    beginChannelSuspend: channelId => run(meta => {
      const channel = channelOf(channelId);
      if (channel.lifecycle !== "open") return view(channel);
      // A checkpointed turn is not running: nothing to wait for.
      const row: ChannelRow = { ...channel, lifecycle: tables.liveTurn(channel.channelId)?.state.status === "running" ? "suspending" : "suspended" };
      tables.putChannel(row); seq(meta);
      return view(row);
    }),

    resumeChannel: channelId => run(meta => {
      requireCompatible();
      const channel = channelOf(channelId);
      if (channel.lifecycle === "open") return { channel: view(channel), ...unblockReminders(meta, channel.channelId) };
      if (channel.lifecycle === "suspending") fail("invalid_state", `Channel ${channel.channelId} is still suspending`);
      const saved = tables.liveTurn(channel.channelId);
      const cont = saved?.state.status === "suspended" && meta.lifecycle === "running" ? saved : undefined;
      if (cont && !compatible(cont))
        fail("incompatible", `Turn ${cont.turnId} was checkpointed under a different configuration`);
      const row: ChannelRow = { ...channel, lifecycle: "open" };
      tables.putChannel(row);
      let turn: StoredTurn | undefined;
      if (cont) { const live: TurnRow = { ...cont, state: { status: "running", ...(cont.state.status === "suspended" && cont.state.dispatchedCallIds !== undefined ? { dispatchedCallIds: cont.state.dispatchedCallIds } : {}) } }; tables.putTurn(live); turn = full(live); }
      seq(meta);
      return { channel: view(row), ...(turn ? { turn } : {}), ...unblockReminders(meta, channel.channelId) };
    }),

    deleteChannel: channelId => run(meta => {
      const channel = tables.channel(channelId as string) ?? fail("not_found", `Unknown channel: ${String(channelId)}`);
      if (channel.lifecycle === "retired") return view(channel);
      if (tables.liveTurn(channel.channelId)) fail("channel_busy", `Channel ${channel.channelId} has an active or checkpointed turn`);
      if (tables.pendingItems(channel.channelId).length) fail("channel_busy", `Channel ${channel.channelId} has pending input`);
      const row: ChannelRow = { ...channel, lifecycle: "retired" };
      tables.putChannel(row); seq(meta);
      const cancelledReminderIds: string[] = [];
      let after = 0;
      for (;;) {
        const batch = reminders.list(channelId, after, 100);
        for (const { reminder } of batch) {
          if (reminder.state !== "active" && reminder.state !== "paused" && reminder.state !== "blocked") continue;
          putReminder(meta, { ...reminder, state: "cancelled", nextRunAt: null });
          cancelledReminderIds.push(reminder.id);
        }
        if (batch.length < 100) break;
        after = batch.at(-1)!.sequence;
      }
      return cancelledReminderIds.length ? { ...view(row), cancelledReminderIds } : view(row);
    }),

    withdrawItem: (channelId, itemId) => run(meta => {
      const known = typeof itemId === "string" ? tables.item(itemId) : undefined;
      if (!known || known.channelId !== channelId) fail("not_found", `Unknown item ${String(itemId)} on channel ${String(channelId)}`);
      const item = known!;
      if (item.milestone === "withdrawn") return { outcome: "withdrawn" as const, item, repeated: true };
      if (item.milestone !== "received") return { outcome: "taken" as const, item, turnId: item.turnId! };
      const withdrawn: StoredItem = { ...item, milestone: "withdrawn", withdrawnAt: now() };
      tables.putItem(withdrawn); seq(meta);
      return { outcome: "withdrawn" as const, item: withdrawn, repeated: false };
    }),

    interruptTurn: (channelId, turnId, reason) => run(meta => {
      if (!text(reason)) fail("invalid_input", "Interruption needs a reason");
      const turn = tables.turn(turnId);
      if (!turn || turn.channelId !== channelId) fail("not_found", `Unknown turn ${String(turnId)} on channel ${String(channelId)}`);
      if (turn!.state.status !== "running") return { interrupted: false as const, turn: full(turn!) };
      const ended = interrupt(turn!, "interrupted", reason); seq(meta);
      return { interrupted: true as const, turn: full(ended) };
    }),

    ownerConfig: () => run(() => ownerSnapshot, true),
    unattendedGuard: () => run(meta => meta.formatVersion >= 8 ? reminders.guardLimit() : undefined, true),
    executionCompatible: () => run(() => !incompatibleViewOnly && referencesCompatible(tables, activeConfig), true),
    importedConfig: () => run(() => tables.getConfig(), true),
    saveConfig: value => run(() => {
      let checked: ManagedConfig;
      try { checked = validateManagedConfig(value); } catch (error) { return fail("invalid_input", String(error)); }
      if (!referencesCompatible(tables, checked)) fail("incompatible", "A stored policy no longer exists");
      tables.setConfig(checked);
    }),
    readExecution: () => run(meta => {
      const channels = tables.channels().map(channel => ({ ...channel, participantIds: [] }));
      const turns = channels.flatMap(({ channelId }) => {
        const active = tables.liveTurn(channelId), last = tables.latestTurn(channelId);
        return [active?.turnId === last?.turnId ? undefined : active, last].flatMap(turn => turn ? [{ ...turn, itemIds: turn.state.status === "failed" || turn.state.status === "interrupted" ? tables.itemsOfTurn(turn.turnId).map(item => item.itemId) : [] }] : []);
      });
      return { revision: meta.revision, session: session(meta), channels, turns,
        items: channels.flatMap(channel => tables.pendingItems(channel.channelId)) };
    }, true),
    readReadyChannels: intake => run(meta => {
      const limit = meta.formatVersion >= 8 ? reminders.guardLimit() : undefined;
      return { lifecycle: meta.lifecycle, channels: tables.channels()
        .filter(({ lifecycle, channelId }) => lifecycle === "open" && tables.pendingCount(channelId) > 0 &&
          (limit === undefined || reminders.guardSpent(channelId) < limit ||
            boundaryPending(channelId, intake).some(item => item.kind === "participant_message")))
        .map(channel => channel.channelId) };
    }, true),
    readRevokedTools: () => run(() => tables.getRevokedTools() ?? [], true),
    readSession: () => run(meta => session(meta), true),
    readChannel: channelId => run(() => {
      const channel = tables.channel(channelId);
      if (!channel) return fail("not_found", "Unknown channel");
      const activeTurn = tables.liveTurn(channelId);
      return { channel, pendingCount: tables.pendingCount(channelId), ...(activeTurn ? { activeTurn } : {}) };
    }, true),
    readTracked: (channelId, itemIds, turnIds) => run(() => {
      if (itemIds.length + turnIds.length > 100) fail("invalid_input", "Too many tracked IDs");
      const items = itemIds.flatMap(id => {
        const item = tables.item(id);
        return item?.channelId === channelId ? [item] : [];
      });
      const turns = turnIds.flatMap(id => {
        const turn = tables.turn(id);
        return turn?.channelId === channelId ? [full(turn)] : [];
      });
      return { items, turns };
    }, true),
    searchTimeline: (input, maxBytes) => run(() => searchTimeline(tables, input, maxBytes), true),
    readMessage: (input, maxBytes) => run(meta => readMessageWindow(tables, meta, input, maxBytes), true),
    readTimeline: range => run(meta => {
      if (!Number.isSafeInteger(range.limit) || range.limit < 1 || range.limit > 100
        || !Number.isSafeInteger(range.throughRevision) || range.throughRevision < 0 || range.throughRevision > meta.revision)
        fail("invalid_input", "Invalid timeline bounds");
      const rows = tables.readRange(range);
      return { entries: rows.slice(0, range.limit), more: rows.length > range.limit };
    }, true),
    readInspectionStatus: () => run(meta => ({
      session: session(meta),
      channels: tables.channels().map(({ channelId, lifecycle }) => {
        const live = tables.liveTurn(channelId), latest = tables.latestTurn(channelId);
        const state = latest?.state;
        return { id: channelId, lifecycle, pending: tables.pendingCount(channelId),
          ...(live ? { turn: live.state.status as "running" | "suspended" } : {}),
          ...(latest && (state?.status === "failed" || state?.status === "interrupted")
            ? { unresolved: { turnId: latest.turnId, ...state } } : {}) };
      }),
    }), true),
    readInspectionPage: before => run(meta => {
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) fail("invalid_input", "Invalid inspection cursor");
      const pageSize = 40, rows = tables.contextRecent(before ?? Number.MAX_SAFE_INTEGER, pageSize + 1, meta.formatVersion < 6);
      const entries: InspectionEntry[] = [], unfinished: ContextTurnOutcome[] = [], turns = new Set<number>();
      let budget = 64 * 1024;
      for (const row of rows.slice(0, pageSize)) {
        if (row.bytes > budget || row.bytes > 16 * 1024) { entries.push({ seq: row.seq, omitted: true }); continue; }
        budget -= row.bytes;
        const saved = tables.contextEntry(row.seq);
        entries.push(saved);
        turns.add(saved.turnId);
      }
      for (const id of turns) {
        if (!budget) break;
        const outcome = tables.contextUnfinished(id, Math.min(budget, 4096));
        if (outcome) { budget -= outcome.bytes; unfinished.push(outcome.outcome); }
      }
      return { entries, unfinished, ...(rows.length > pageSize ? { next: entries.at(-1)!.seq } : {}) };
    }, true),
    readInspectionCalls: channel => run(() => {
      const calls = tables.getModelState()?.calls ?? [];
      const page: ModelCallSummary[] = [];
      for (let i = calls.length - 1; i >= 0 && page.length < 40; i--) {
        const call = calls[i]!;
        if (call.channel === channel) page.push(call);
      }
      return page;
    }, true),
    readInferencePolicies: (turnId, limits) => run(() => {
      if (!validReadLimits(limits)) fail("invalid_input", "Invalid inference read limits");
      return tables.contextPolicies(turnId, limits.maxReadRecords, limits.maxReadBytes)?.names ?? { code: "context_limit" as const };
    }, true),
    readInferenceContext: input => run(meta => {
      if (meta.formatVersion < 6) fail("incompatible", "Inference reads need a recovered session");
      if (!validReadLimits(input.limits)) fail("invalid_input", "Invalid inference read limits");
      const start = tables.contextTurnStart(input.channelId, input.turnId) ?? fail("not_found", "Turn not found on channel");
      return readInference(tables, input, start);
    }, true),
    snapshot: () => run(() => readSnapshot(tables), true),

    exportArchive: () => run(meta => {
      const snapshot = readSnapshot(tables);
      if (snapshot.modelCalls.some(call => call.outcome === "running" || call.attempts.some(attempt => attempt.outcome === "running")))
        fail("busy", "A model call or attempt is still running");
      const idle = meta.lifecycle === "running" && !snapshot.turns.some(turn => turn.state.status === "running" || turn.state.status === "suspended")
        && !snapshot.channels.some(channel => channel.lifecycle === "suspending")
        && !snapshot.items.some(item => item.milestone === "received");
      if (meta.lifecycle !== "suspended" && !idle) fail("busy", "Export needs an idle or cleanly suspended session");
      let archiveFormat = meta.formatVersion;
      if (archiveFormat === 9) {
        const attachments = tables.attachments;
        if (!attachments || attachments.hasRetained()) throw new Fail("invalid_archive", "Attachment-bearing export is unavailable");
        const base = attachments.baseFormat();
        if (base !== 6 && base !== 7 && base !== 8) throw new Fail("invalid_archive", "Invalid attachment base format");
        archiveFormat = base;
        snapshot.session.formatVersion = base;
      }
      const archive: SessionArchive = { format: "harness-session", archiveVersion: archiveFormat >= 8 ? 7 : archiveFormat === 7 ? 6 : 5, exportedAt: now(), snapshot,
        ...(archiveFormat >= 7 ? { reminderState: reminders.archive() } : {}),
        allocation: { nextTurnId: meta.nextTurnId, nextSeq: meta.revision + 1, nextItemNumber: meta.nextItemNumber } };
      return archive;
    }),

    close() {
      if (closed) return { ok: true, value: undefined, revision: 0 };
      let revision: number;
      try { revision = tables.getMeta().revision; release(); }
      catch (error) { return failure(error); }
      closed = true;
      return { ok: true, value: undefined, revision };
    },
  };
}
