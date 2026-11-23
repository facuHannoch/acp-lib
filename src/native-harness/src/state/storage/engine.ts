import type { OperatorStorageReads } from "../../contracts/operator-controls.ts";
import type { ModelCallSummary } from "../../contracts/model-execution.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";
import { externalNoticeSignature, policyItemSignature, contributingPolicies, fingerprint } from "./policy-metadata.ts";
import { readInference, validReadLimits, type ContextRows } from "./inference.ts";
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
  readRange(range: Parameters<OperatorStorageReads["readTimeline"]>[0]): TimelineEntry[];
  pendingCount(channel: string): number;
  getModelState(): ModelState | undefined;
  setModelState(state: ModelState): void;
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
  pendingItems(channelId: string): StoredItem[];
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
  return { sessionId: meta.sessionId, formatVersion: 6, createdAt: meta.createdAt,
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
export function recover(tables: Tables, upgrade?: () => void): void {
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
export function createEngine(tables: Tables, ownerKey: string, release: () => void, config?: ManagedConfig, incompatibleViewOnly = false): SessionStorage {
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
    const state = tables.getModelState() ?? emptyModelState(); let changed = false;
    for (const call of state.calls) if (call.turnId === String(turnId) && call.outcome === "running") {
      call.outcome = "interrupted"; call.endedAt = now(); changed = true;
      for (const attempt of call.attempts) if (attempt.outcome === "running") { attempt.outcome = "interrupted"; attempt.endedAt = call.endedAt; }
    }
    if (changed) tables.setModelState(state);
  };
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
      state.calls.push(call); state.itemIds[id] = [...itemIds]; tables.setModelState(state); seq(meta); return call;
    }),
    startAttempt: (id, scripted) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id); running(Number(call.turnId));
      if (call.outcome !== "running" || call.attempts.length >= 2 || call.attempts.some(a => a.outcome === "running")) fail("invalid_state", "Cannot start another model attempt");
      const ordinal = call.attempts.length, step = Object.hasOwn(state.scriptPositions, call.channel) ? state.scriptPositions[call.channel]! : 0;
      const attempt: ModelCallSummary["attempts"][number] = { attemptId: `${id}:${ordinal}`, ordinal, startedAt: now(), outcome: "running", ...(ordinal ? { retryReason: call.attempts[ordinal - 1]?.outcome } : {}), ...(scripted ? { scriptStep: step } : {}) };
      if (scripted) Object.defineProperty(state.scriptPositions, call.channel, { value: step + 1, writable: true, configurable: true, enumerable: true });
      call.attempts.push(attempt); tables.setModelState(state); seq(meta); return attempt;
    }),
    confirm: (id, attemptId, milestone) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(); activeAttempt(state, id, attemptId);
      if (milestone !== "delivered" && milestone !== "seen") fail("invalid_input", "Invalid receipt");
      const advanced = (state.itemIds[id] ?? []).map(itemId => tables.item(itemId)!).filter(item => RANK[item.milestone] < RANK[milestone]);
      for (const item of advanced) tables.putItem({ ...item, milestone });
      if (advanced.length) seq(meta); return advanced.map(item => item.itemId);
    }),
    recordProviderRequestId: (id, attemptId, requestId) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), { attempt } = activeAttempt(state, id, attemptId);
      if (!text(requestId)) fail("invalid_input", "Invalid provider request ID");
      if (!attempt.providerRequestId) { attempt.providerRequestId = requestId; tables.setModelState(state); seq(meta); }
    }),
    recordUsage: (id, attemptId, usage) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id);
      const attempt = call.attempts.find(value => value.attemptId === attemptId);
      if (!attempt) return fail("not_found", "Unknown model attempt");
      if (call.outcome !== "running" || attempt.outcome !== "running" || tables.turn(Number(call.turnId))?.state.status !== "running") return;
      if (!usage || typeof usage !== "object" || Object.keys(usage).some(key => !["inputTokens", "outputTokens", "totalTokens"].includes(key))
        || Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) fail("invalid_input", "Invalid provider usage");
      attempt.usage = structuredClone(usage); tables.setModelState(state); seq(meta);
    }),
    finishAttempt: (id, attemptId, outcome, requestId) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), { attempt } = activeAttempt(state, id, attemptId);
      if (!["transient_failure", "invalid_request", "invalid_config", "provider_failure", "incomplete", "output_limit", "timeout", "interrupted"].includes(outcome) || (requestId !== undefined && !text(requestId))) fail("invalid_input", "Invalid attempt outcome or provider ID");
      attempt.outcome = outcome; attempt.endedAt = now(); if (!attempt.providerRequestId && requestId) attempt.providerRequestId = requestId;
      tables.setModelState(state); seq(meta);
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
      tables.setModelState(state); return { ...entry, messageId: call.messageId };
    }),
    finishCall: (id, outcome) => run(meta => {
      const state = tables.getModelState() ?? emptyModelState(), call = modelCall(state, id); running(Number(call.turnId));
      if (call.outcome !== "running" || call.attempts.some(a => a.outcome === "running")) fail("invalid_state", "Cannot finish model call");
      if (!["failed", "incomplete", "output_limit", "timeout", "interrupted"].includes(outcome)) fail("invalid_input", "Invalid call outcome");
      call.outcome = outcome; call.endedAt = now(); tables.setModelState(state); seq(meta);
    }),
    readCalls: (after, limit = 100) => run(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input", "Invalid model call page size");
      const calls = (tables.getModelState() ?? emptyModelState()).calls, at = after ? calls.findIndex(call => call.callId === after) : -1;
      if (after && at < 0) fail("not_found", "Unknown model call cursor");
      const page = calls.slice(at + 1, at + 1 + limit); return { calls: page, ...(at + 1 + limit < calls.length ? { next: page.at(-1)!.callId } : {}) };
    }, true),
    acceptItem: input => run(meta => {
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
    }, input?.kind === "external_notice"),

    beginTurn: channelId => run(meta => {
      requireCompatible();
      if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; no turn can begin`);
      const channel = channelOf(channelId);
      if (channel.lifecycle !== "open") fail("channel_suspended", `Channel ${channel.channelId} is ${channel.lifecycle}; no turn can begin`);
      if (tables.liveTurn(channel.channelId)) return null;
      const pending = tables.pendingItems(channelId);
      if (!pending.length) return null;
      const turn: TurnRow = { turnId: meta.nextTurnId++, channelId, startedSeq: seq(meta), startedAt: now(),
        compatibilityKey: ownerKey, state: { status: "running" } };
      tables.putTurn(turn);
      return take(meta, turn, pending);
    }),

    takePending: turnId => run(meta => {
      const turn = running(turnId);
      if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; input stays pending`);
      const channel = channelOf(turn.channelId);
      if (channel.lifecycle !== "open") fail("channel_suspended", `Channel ${channel.channelId} is ${channel.lifecycle}; input stays pending`);
      return take(meta, turn, tables.pendingItems(turn.channelId));
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
        const pending = tables.pendingItems(turn.channelId).length;
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
      if (meta.lifecycle === "running") return { session: session(meta), turns: [] };
      if (meta.lifecycle !== "suspended") fail("invalid_state", "Session is still suspending");
      // Turns of individually suspended (or retired) channels are not ours to resume.
      const saved = tables.turns().filter(turn => turn.state.status === "suspended"
        && ["open", "suspending"].includes(tables.channel(turn.channelId)?.lifecycle ?? "retired"));
      const foreign = saved.find(turn => !compatible(turn));
      if (foreign) fail("incompatible", `Turn ${foreign.turnId} was checkpointed under a different configuration`);
      const turns = saved.map(turn => { const live: TurnRow = { ...turn, state: { status: "running", ...(turn.state.status === "suspended" && turn.state.dispatchedCallIds !== undefined ? { dispatchedCallIds: turn.state.dispatchedCallIds } : {}) } }; tables.putTurn(live); return full(live); });
      meta.lifecycle = "running"; seq(meta);
      return { session: session(meta), turns };
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
      if (channel.lifecycle === "open") return { channel: view(channel) };
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
      return { channel: view(row), ...(turn ? { turn } : {}) };
    }),

    deleteChannel: channelId => run(meta => {
      const channel = tables.channel(channelId as string) ?? fail("not_found", `Unknown channel: ${String(channelId)}`);
      if (channel.lifecycle === "retired") return view(channel);
      if (tables.liveTurn(channel.channelId)) fail("channel_busy", `Channel ${channel.channelId} has an active or checkpointed turn`);
      if (tables.pendingItems(channel.channelId).length) fail("channel_busy", `Channel ${channel.channelId} has pending input`);
      const row: ChannelRow = { ...channel, lifecycle: "retired" };
      tables.putChannel(row); seq(meta);
      return view(row);
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
    readReadyChannels: () => run(meta => ({ lifecycle: meta.lifecycle,
      channels: tables.channels().filter(channel => channel.lifecycle === "open" && tables.pendingCount(channel.channelId) > 0).map(channel => channel.channelId) }), true),
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
    readTimeline: range => run(meta => {
      if (!Number.isSafeInteger(range.limit) || range.limit < 1 || range.limit > 100
        || !Number.isSafeInteger(range.throughRevision) || range.throughRevision < 0 || range.throughRevision > meta.revision)
        fail("invalid_input", "Invalid timeline bounds");
      const rows = tables.readRange(range);
      return { entries: rows.slice(0, range.limit), more: rows.length > range.limit };
    }, true),
    readInferenceContext: input => run(meta => {
      if (meta.formatVersion !== 6) fail("incompatible", "Inference reads need a recovered session");
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
      const archive: SessionArchive = { format: "harness-session", archiveVersion: 5, exportedAt: now(), snapshot,
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
