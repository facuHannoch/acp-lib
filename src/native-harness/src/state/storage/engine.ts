import { createHash } from "node:crypto";
import type {
  AcceptItem, SessionArchive, SessionLifecycle, SessionStorage, StorageErrorCode, StorageResult,
  StorageSnapshot, StoredItem, StoredSession, StoredTurn, TimelineEntry, TurnTake,
} from "../../contracts/storage.ts";

/** Session-wide scalars. `revision` is also the last allocated global seq. */
export interface Meta {
  sessionId: string; formatVersion: number; createdAt: string; compatibilityKey: string;
  lifecycle: SessionLifecycle; revision: number; nextTurnId: number; nextItemNumber: number;
}
/** A turn as stored; `itemIds` is derived from the items linked to it. */
export type TurnRow = Omit<StoredTurn, "itemIds">;

/** Row access shared by the memory and SQLite adapters. The engine owns every
 * rule of the storage contract; a backend only stores rows and makes
 * `transaction` atomic (all writes of a throwing callback are undone). */
export interface Tables {
  transaction<T>(run: () => T): T;
  getMeta(): Meta;
  setMeta(meta: Meta): void;
  hasChannel(channelId: string): boolean;
  addChannel(channelId: string): void;
  channels(): string[];
  /** Idempotent. */
  addParticipant(participantId: string): void;
  participants(): string[];
  item(itemId: string): StoredItem | undefined;
  /** Insert, or update milestone/turn link of an existing item. */
  putItem(item: StoredItem): void;
  /** Milestone `received`, in acceptedSeq order. */
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
  addEntry(entry: TimelineEntry): void;
  entriesOfTurn(turnId: number): TimelineEntry[];
  entries(): TimelineEntry[];
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
const RANK = { received: 0, taken: 1, delivered: 2, seen: 3 } as const;

/** The contract's exact signature; identical for both adapters and archives. */
export function signatureOf(item: Pick<AcceptItem, "kind" | "channelId" | "senderId" | "sourceChannelId" | "text">): string {
  return createHash("sha256").update(JSON.stringify(
    [item.kind, item.channelId, item.senderId, item.sourceChannelId ?? null, item.text]), "utf8").digest("hex");
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
    if (typeof m.content !== "string" || !text(m.callId) || keys.some(key => !["role", "content", "callId"].includes(key)))
      fail("invalid_input", "Tool result needs content and callId");
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
  return { sessionId: meta.sessionId, formatVersion: 2, createdAt: meta.createdAt,
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
    channels: tables.channels().map(channelId => ({ channelId, participantIds: [...spoke.get(channelId) ?? []] })),
    participants: tables.participants().map(participantId => ({ participantId })),
    turns: tables.turns().map(row => ({ ...row, itemIds: tables.itemsOfTurn(row.turnId).map(item => item.itemId) })),
    items: tables.items(), timeline,
  };
}

/** Reopen recovery, one transaction, executes nothing. A cleanly suspended
 * session, or a running one with no unfinished turn, is left unwritten. */
export function recover(tables: Tables): void {
  tables.transaction(() => {
    const meta = tables.getMeta();
    if (meta.lifecycle === "suspended") return;
    const live = tables.turns().filter(turn => turn.state.status === "running" || turn.state.status === "suspended");
    if (!live.length && meta.lifecycle === "running") return;
    for (const turn of live) tables.putTurn({ ...turn, state: { status: "interrupted",
      reason: "The owning process exited before this turn finished", uncertainCallIds: unanswered(tables, turn.turnId) } });
    tables.setMeta({ ...meta, lifecycle: "running", revision: meta.revision + 1 });
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

/** The contract over any backend. `ownerKey` is the key passed to this open. */
export function createEngine(tables: Tables, ownerKey: string, release: () => void): SessionStorage {
  let closed = false;
  const now = () => new Date().toISOString();

  function run<T>(work: (meta: Meta) => T): StorageResult<T> {
    if (closed) return failure(new Fail("closed", "Storage handle is closed"));
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
        itemId: item.itemId, message: { role: "user", content: item.kind === "channel_notice" ? item.text
          : `Participant: ${JSON.stringify(item.senderId)}\n\n${item.text}` } };
      tables.addEntry(entry);
      const taken: StoredItem = { ...item, milestone: "taken", turnId: turn.turnId, entrySeq: entry.seq };
      tables.putItem(taken);
      items.push(taken); entries.push(entry);
    }
    return { turn: full(turn), items, entries };
  }
  function interrupt(turn: TurnRow, status: "failed" | "interrupted", reason: string): TurnRow {
    const ended: TurnRow = { ...turn, state: { status, reason, uncertainCallIds: unanswered(tables, turn.turnId) } };
    tables.putTurn(ended);
    return ended;
  }

  return {
    acceptItem: input => run(meta => {
      const shaped = !!input && typeof input === "object"
        && [input.kind, input.channelId, input.senderId, input.text].every(value => typeof value === "string")
        && (input.sourceChannelId === undefined || typeof input.sourceChannelId === "string");
      if (shaped && typeof input.itemId === "string") {
        const known = tables.item(input.itemId);
        if (known) {
          if (known.signature !== signatureOf(input)) fail("item_conflict", `Item ID ${input.itemId} already identifies different input`);
          return { item: known, duplicate: true };
        }
      }
      const notice = shaped && input.kind === "channel_notice";
      if (!shaped || !(notice || input.kind === "participant_message") || ![input.channelId, input.senderId, input.text].every(text)
        || (input.itemId !== undefined && !text(input.itemId))
        || (notice ? !text(input.sourceChannelId) : input.sourceChannelId !== undefined))
        fail("invalid_input", "Item needs kind, channelId, senderId and text; a notice also needs sourceChannelId");
      if (notice && !tables.hasChannel(input.channelId)) fail("not_found", `Unknown channel: ${input.channelId}`);
      if (meta.lifecycle === "suspended" || (meta.lifecycle === "suspending" && !notice))
        fail("not_running", `Session is ${meta.lifecycle}; new work is not admitted`);
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
      const item: StoredItem = { itemId, kind: input.kind, channelId: input.channelId, senderId: input.senderId,
        ...(notice ? { sourceChannelId: input.sourceChannelId } : {}), text: input.text,
        signature: signatureOf(input), acceptedSeq: seq(meta), acceptedAt: now(), milestone: "received" };
      if (!notice) {
        if (!tables.hasChannel(item.channelId)) tables.addChannel(item.channelId);
        tables.addParticipant(item.senderId);
      }
      tables.putItem(item);
      return { item, duplicate: false };
    }),

    beginTurn: channelId => run(meta => {
      if (meta.lifecycle !== "running") fail("not_running", `Session is ${meta.lifecycle}; no turn can begin`);
      if (typeof channelId !== "string" || tables.liveTurn(channelId)) return null;
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
      } else if (!open.includes(message.callId)) fail("invalid_input", `No unanswered call ${message.callId} in this turn`);
      const entry: TimelineEntry = { seq: seq(meta), at: now(), channelId: turn.channelId, turnId,
        from: message.role === "tool" ? "tool" : "agent", message: structuredClone(message) };
      tables.addEntry(entry);
      return entry;
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
        tables.putTurn(done); seq(meta);
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
      if (meta.lifecycle !== "suspending") fail("invalid_state", "Checkpoints are saved only while suspending");
      if (unanswered(tables, turnId).length) fail("invalid_state", "A tool call in this turn has no recorded result");
      const last = tables.entriesOfTurn(turnId).at(-1);
      if (last?.message.role === "assistant" && !last.message.calls.length && !tables.pendingItems(turn.channelId).length)
        fail("invalid_state", "This turn is finished; complete it instead of checkpointing");
      const saved: TurnRow = { ...turn, state: { status: "suspended",
        checkpoint: { nextStep: "inference", afterSeq: last?.seq ?? turn.startedSeq } } };
      tables.putTurn(saved); seq(meta);
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
      if (meta.lifecycle === "running") return { session: session(meta), turns: [] };
      if (meta.lifecycle !== "suspended") fail("invalid_state", "Session is still suspending");
      const saved = tables.turns().filter(turn => turn.state.status === "suspended");
      const foreign = saved.find(turn => turn.compatibilityKey !== ownerKey);
      if (foreign) fail("incompatible", `Turn ${foreign.turnId} was checkpointed under a different configuration`);
      const turns = saved.map(turn => { const live: TurnRow = { ...turn, state: { status: "running" } }; tables.putTurn(live); return full(live); });
      meta.lifecycle = "running"; seq(meta);
      return { session: session(meta), turns };
    }),

    interruptActive: reason => run(meta => {
      if (!text(reason)) fail("invalid_input", "Interruption needs a reason");
      if (meta.lifecycle === "suspended") return [];
      const suspending = meta.lifecycle === "suspending";
      const ended = tables.turns().filter(turn => turn.state.status === "running" || (suspending && turn.state.status === "suspended"))
        .map(turn => full(interrupt(turn, "interrupted", reason)));
      if (suspending) meta.lifecycle = "running";
      if (ended.length || suspending) seq(meta);
      return ended;
    }),

    snapshot: () => run(() => readSnapshot(tables)),

    exportArchive: () => run(meta => {
      const snapshot = readSnapshot(tables);
      const idle = meta.lifecycle === "running" && !snapshot.turns.some(turn => turn.state.status === "running")
        && !snapshot.items.some(item => item.milestone === "received");
      if (meta.lifecycle !== "suspended" && !idle) fail("busy", "Export needs an idle or cleanly suspended session");
      const archive: SessionArchive = { format: "harness-session", archiveVersion: 1, exportedAt: now(), snapshot,
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
