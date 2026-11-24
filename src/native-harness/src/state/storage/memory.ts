import { historicalCandidate, historicalRetrievalProjection, retrievalMessage, timelineTokens, timelineBytes } from "../../util/timeline-text.ts";
import { byteLength, entryOverhead, type ContextRow } from "./inference.ts";
import { checkScriptIdentity } from "./script-identity.ts";
import type { SessionStorageAdapter, StoredItem, TimelineEntry } from "../../contracts/storage.ts";
import { Fail, createEngine, failure, recover, referencesCompatible, type ChannelRow, type Meta, type Tables, type TurnRow, type ModelState } from "./engine.ts";
import { archiveMeta, restoreArchive, storedSession, validateArchive, validateSessionPayload } from "./archive.ts";
import { validateManagedConfig } from "../../util/config.ts";

type ContextEntry = ContextRow & { entry: TimelineEntry };

interface Data {
  bySeq: Map<number, ContextEntry>;
  retrievalReplies: Map<string, number>;
  historicalCandidates: TimelineEntry[];
  retrievalCalls: Map<number, Set<string>>;
  retrievalIndex: Map<number, { bytes: number; words: Set<string> }>;
  byTurn: Map<number, ContextEntry[]>;
  inputs: Map<number, ContextEntry[]>;
  assistants: Map<number, ContextEntry[]>;
  turnPolicies: Map<number, Set<string>>;
  revokedTools?: string[];
  modelState?: ModelState;
  config?: import("../../contracts/session-file.ts").PortableSessionConfig;
  meta: Meta;
  channels: Map<string, ChannelRow>; participants: Set<string>;
  items: Map<string, StoredItem>; turns: Map<number, TurnRow>; entries: TimelineEntry[]; conversation: Map<string, TimelineEntry[]>; replies: Map<number, TimelineEntry[]>;
}
const empty = (meta: Meta): Data => ({ meta, channels: new Map(), participants: new Set(), items: new Map(), turns: new Map(), entries: [], bySeq: new Map(), retrievalReplies: new Map(), retrievalIndex: new Map(), historicalCandidates: [], retrievalCalls: new Map(), byTurn: new Map(), inputs: new Map(), assistants: new Map(), turnPolicies: new Map(), conversation: new Map(), replies: new Map() });
const copy = <T>(value: T): T => structuredClone(value);
const live = (turn: TurnRow) => turn.state.status === "running" || turn.state.status === "suspended";

/** Rows in maps. Each write records how to undo itself, so a throwing
 * transaction leaves no partial change without copying the whole session. */
function memoryTables(data: Data): Tables {
  let undo: (() => void)[] | undefined;
  const log = (step: () => void) => { undo?.push(step); };
  const before = (rows: readonly { seq: number }[], seq: number) => {
    let low = 0, high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid]!.seq < seq) low = mid + 1; else high = mid;
    }
    return low;
  };
  const recent = <T>(rows: T[], limit: number, end = rows.length) => rows.slice(Math.max(0, end - limit), end).reverse();
  const header = ({ seq, bytes, kind, entry }: ContextEntry): ContextRow => ({
    seq, ...(entry.itemId === undefined ? {} : { textBytes: byteLength(data.items.get(entry.itemId)?.text ?? "") }),
    bytes: bytes + byteLength(data.modelState?.entryIds[String(seq)] ?? entry.messageId ?? ""), kind,
  });
  const historicalHeader = (row: ContextEntry): ContextRow => {
    const base = header(row), projected = historicalRetrievalProjection(row.entry.message);
    return projected === row.entry.message ? base : { ...base,
      bytes: base.bytes - byteLength(JSON.stringify(row.entry.message)) + byteLength(JSON.stringify(projected)) };
  };
  return {
    contextTurnStart(channelId, turnId) {
      const turn = data.turns.get(turnId);
      return turn?.channelId === channelId ? turn.startedSeq : undefined;
    },
    contextTrigger(turnId) {
      const first = data.inputs.get(turnId)?.[0];
      return first && header(first);
    },
    contextPreviousResponse: turnId => data.assistants.get(turnId)?.at(-1)?.seq ?? 0,
    contextInputs(turnId, after, limit) {
      const rows = data.inputs.get(turnId) ?? [];
      const start = before(rows, after + 1);
      return rows.slice(start, start + limit).map(header);
    },
    contextActive: (turnId, limit) => recent(data.byTurn.get(turnId) ?? [], limit).map(header),
    contextLocal(channelId, start, limit) {
      const rows = data.conversation.get(channelId) ?? [];
      return recent(rows, limit, before(rows, start)).map(row => historicalHeader(data.bySeq.get(row.seq)!));
    },
    contextRecent(cursor, limit) {
      return recent(data.entries, limit, before(data.entries, cursor)).map(row => header(data.bySeq.get(row.seq)!));
    },
    contextShared(channelId, limit) {
      return recent(data.historicalCandidates, limit).filter(row => row.channelId !== channelId &&
        (row.kind === "participant_message" || (row.message.role === "assistant" && !!row.message.content)))
        .map(row => historicalHeader(data.bySeq.get(row.seq)!));
    },
    contextPolicies(turnId, limit, budget) {
      const names = data.turnPolicies.get(turnId);
      if (!names) return { names: [], bytes: 0 };
      if (names.size > limit) return undefined;
      let bytes = 0;
      for (const name of names) {
        bytes += byteLength(name) + 1;
        if (bytes > budget) return undefined;
      }
      return { names: [...names].sort(), bytes };
    },
    contextUnfinished(turnId, budget) {
      const turn = data.turns.get(turnId);
      if (!turn || (turn.state.status !== "failed" && turn.state.status !== "interrupted")) return undefined;
      const { channelId, state } = turn;
      const bytes = entryOverhead + byteLength(channelId) + byteLength(JSON.stringify(state));
      return bytes <= budget ? { outcome: { channelId, turnId, state }, bytes } : undefined;
    },
    retrievalCandidates(terms, channel, limit) {
      const rows: { seq: number; bytes: number }[] = [];
      const entries = channel === undefined ? data.entries : data.conversation.get(channel) ?? [];
      for (let i = entries.length - 1; i >= 0 && rows.length < limit; i--) {
        const seq = entries[i]!.seq, indexed = data.retrievalIndex.get(seq);
        if (indexed && terms.every(term => indexed.words.has(term))) rows.push({ seq, bytes: indexed.bytes });
      }
      return rows;
    },
    retrievalEntry(seq) {
      const entry = data.bySeq.get(seq)?.entry;
      if (!entry) return;
      const messageId = data.modelState?.entryIds[String(seq)] ?? entry.messageId;
      return copy(messageId === undefined ? entry : { ...entry, messageId });
    },
    retrievalReplyId: id => data.retrievalReplies.get(id),
    contextHistoricalEntry(seq) {
      const saved = this.contextEntry(seq);
      return { ...saved, message: historicalRetrievalProjection(saved.message) };
    },
    contextEntry(seq) {
      const entry = data.bySeq.get(seq)!.entry;
      const messageId = data.modelState?.entryIds[String(seq)] ?? entry.messageId;
      // The engine detaches the selected values at the transaction boundary.
      return messageId ? { ...entry, messageId } : entry;
    },
    modelCallPage(after, count) {
      const calls = data.modelState?.calls ?? [];
      if (after === undefined) return copy(calls.slice(0, count));
      let lo = 0, hi = calls.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (Number(calls[mid]!.callId) < Number(after)) lo = mid + 1;
        else hi = mid;
      }
      if (calls[lo]?.callId !== after) throw new Fail("not_found", "Unknown call cursor");
      return copy(calls.slice(lo + 1, lo + 1 + count));
    },
    getModelState: () => copy(data.modelState),
    setModelState(state) { const old = data.modelState; log(() => { data.modelState = old; }); data.modelState = copy(state); },
    getRevokedTools: () => copy(data.revokedTools),
    setRevokedTools(names) { const old = data.revokedTools; log(() => { data.revokedTools = old; }); data.revokedTools = [...names]; },
    getConfig: () => copy(data.config),
    setConfig(config) { const old = data.config; log(() => { data.config = old; }); data.config = copy(config); },
    transaction(run) {
      if (undo) return run();
      undo = [];
      try { return run(); }
      catch (error) { for (const step of undo.reverse()) step(); throw error; }
      finally { undo = undefined; }
    },
    getMeta: () => ({ ...data.meta }),
    setMeta(meta) { const old = data.meta; log(() => { data.meta = old; }); data.meta = { ...meta }; },
    channel: id => copy(data.channels.get(id)),
    putChannel(channel) {
      const old = data.channels.get(channel.channelId);
      log(() => { if (old) data.channels.set(channel.channelId, old); else data.channels.delete(channel.channelId); });
      data.channels.set(channel.channelId, copy(channel));
    },
    channels: () => copy([...data.channels.values()]),
    addParticipant(id) { if (!data.participants.has(id)) { data.participants.add(id); log(() => data.participants.delete(id)); } },
    participants: () => [...data.participants],
    item: id => copy(data.items.get(id)),
    putItem(item) {
      const old = data.items.get(item.itemId);
      log(() => { if (old) data.items.set(item.itemId, old); else data.items.delete(item.itemId); });
      data.items.set(item.itemId, copy(item));
      if (old?.turnId !== undefined || item.turnId === undefined) return;
      const turnId = item.turnId;
      let names = data.turnPolicies.get(turnId);
      if (!names) {
        names = new Set();
        data.turnPolicies.set(turnId, names);
        log(() => { data.turnPolicies.delete(turnId); });
      }
      const policy = item.policy;
      for (const name of policy ? [policy.resolved, ...policy.inherited] : ["__legacy_allow"]) {
        if (names.has(name)) continue;
        const namesForUndo = names;
        names.add(name);
        log(() => { namesForUndo.delete(name); });
      }
    },
    pendingItems: (channelId, limit) => copy([...data.items.values()].filter(item => item.channelId === channelId && item.milestone === "received")
      .sort((a, b) => a.acceptedSeq - b.acceptedSeq).slice(0, limit ?? Infinity)),
    itemsOfTurn: turnId => copy([...data.items.values()].filter(item => item.turnId === turnId).sort((a, b) => a.entrySeq! - b.entrySeq!)),
    items: () => copy([...data.items.values()].sort((a, b) => a.acceptedSeq - b.acceptedSeq)),
    turn: id => copy(data.turns.get(id)),
    putTurn(turn) {
      const old = data.turns.get(turn.turnId);
      // Same invariant the SQLite schema enforces with a partial unique index.
      if (live(turn)) for (const other of data.turns.values())
        if (other.turnId !== turn.turnId && other.channelId === turn.channelId && live(other)) throw new Error("Channel already has a live turn");
      log(() => { if (old) data.turns.set(turn.turnId, old); else data.turns.delete(turn.turnId); });
      data.turns.set(turn.turnId, copy(turn));
    },
    liveTurn: channelId => copy([...data.turns.values()].find(turn => turn.channelId === channelId && live(turn))),
    turns: () => copy([...data.turns.values()].sort((a, b) => a.turnId - b.turnId)),
    latestTurn: id => copy([...data.turns.values()].findLast(turn => turn.channelId === id)),
    liveTurns: () => copy([...data.turns.values()].filter(live)),
    policyNames: () => [...new Set([...data.channels.values()].flatMap(channel => channel.policy ? [channel.policy] : [])
      .concat([...data.items.values()].flatMap(item => item.policy ? [item.policy.resolved, ...item.policy.inherited] : ["__legacy_allow"])))],
    pendingCount: id => [...data.items.values()].filter(item => item.channelId === id && item.milestone === "received").length,
    readRange(range) {
      const older = range.direction === "older";
      const select = (rows: TimelineEntry[]) => {
        const before = (seq: number) => older ? seq <= range.throughRevision && seq < (range.exclusiveSeq ?? Infinity) : seq <= (range.exclusiveSeq ?? 0);
        let low = 0, high = rows.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (before(rows[mid]!.seq)) low = mid + 1; else high = mid;
        }
        return older ? rows.slice(Math.max(0, low - range.limit - 1), low).reverse()
          : rows.slice(low, low + range.limit + 1).filter(row => row.seq <= range.throughRevision);
      };
      const rows = range.kind === "conversation" ? select(data.conversation.get(range.channel!) ?? [])
        : range.kind === "replies" ? (range.turnIds ?? []).flatMap(id => select(data.replies.get(id) ?? []))
          .filter(row => row.channelId === range.channel).sort((a, b) => older ? b.seq - a.seq : a.seq - b.seq).slice(0, range.limit + 1)
        : select(data.entries);
      return copy(rows.map(row => {
        const messageId = data.modelState?.entryIds[String(row.seq)];
        return messageId ? { ...row, messageId } : row;
      }));
    },
    addEntry(entry) {
      const saved = copy(entry);
      if (saved.messageId !== undefined) {
        const id = saved.messageId;
        data.retrievalReplies.set(id, saved.seq);
        log(() => { data.retrievalReplies.delete(id); });
      }
      const append = <T>(rows: T[], row: T) => { rows.push(row); log(() => { rows.pop(); }); };
      const indexed = <K, T>(index: Map<K, T[]>, key: K, row: T) => {
        let rows = index.get(key);
        if (!rows) { rows = []; index.set(key, rows); log(() => { index.delete(key); }); }
        append(rows, row);
      };
      const searchable = retrievalMessage(saved);
      if (searchable) {
        data.retrievalIndex.set(saved.seq, { bytes: timelineBytes(searchable.text),
          words: new Set(timelineTokens(searchable.text).map(word => word.folded)) });
        log(() => { data.retrievalIndex.delete(saved.seq); });
      }
      if (historicalCandidate(saved.message, id => {
        let calls = data.retrievalCalls.get(saved.turnId);
        if (!calls) {
          calls = new Set();
          data.retrievalCalls.set(saved.turnId, calls);
          log(() => { data.retrievalCalls.delete(saved.turnId); });
        }
        if (!calls.has(id)) {
          const registered = calls;
          registered.add(id);
          log(() => { registered.delete(id); });
        }
      }, id => data.retrievalCalls.get(saved.turnId)?.has(id) ?? false)) append(data.historicalCandidates, saved);
      append(data.entries, saved);
      const kind = saved.message.role === "assistant" ? "assistant" : saved.itemId !== undefined ? "input" : "other";
      const bytes = entryOverhead + byteLength(JSON.stringify(saved.message)) +
        byteLength(saved.at) + byteLength(saved.channelId) + byteLength(saved.from) + byteLength(saved.kind ?? "") +
        byteLength(saved.sourceChannelId ?? "") + byteLength(saved.itemId ?? "") + byteLength(saved.externalSource ?? "");
      const contextRow: ContextEntry = { entry: saved, seq: saved.seq, bytes, kind };
      data.bySeq.set(saved.seq, contextRow);
      log(() => { data.bySeq.delete(saved.seq); });
      indexed(data.byTurn, saved.turnId, contextRow);
      if (kind === "input") indexed(data.inputs, saved.turnId, contextRow);
      if (kind === "assistant") indexed(data.assistants, saved.turnId, contextRow);
      const reply = entry.message.role === "assistant" && !!entry.message.content;
      if (reply || entry.kind === "participant_message") {
        indexed(data.conversation, entry.channelId, saved);
      }
      if (reply) indexed(data.replies, entry.turnId, saved);
    },
    entriesOfTurn: turnId => copy(data.entries.filter(entry => entry.turnId === turnId)),
    entries: () => copy(data.entries),
  };
}

/** One in-memory location with the same semantics as a database file: the
 * session outlives its handle, so close and open behave like a restart within
 * one process. Nothing survives the process itself. */
export function createMemoryStorageAdapter(): SessionStorageAdapter {
  let data: Data | undefined;
  let owned = false;
  return {
    readSavedConfig() {
      if (!data) return failure(new Fail("not_found", "No session exists at this location"));
      if (owned) return failure(new Fail("owner_conflict", "Session storage already has an owner"));
      return { ok: true, value: copy(data.config), revision: data.meta.revision };
    },
    importSessionFile(payload, options) {
      try {
        const { archive, config } = validateSessionPayload(payload);
        if (options?.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId.trim())) throw new Fail("invalid_input", "sessionId must be a nonempty string");
        if (data) throw new Fail("already_exists", "A session already exists at this location");
        const next = empty(archiveMeta(copy(archive), options?.sessionId));
        const tables = memoryTables(next); tables.transaction(() => { restoreArchive(tables, archive); tables.setConfig(config); });
        data = next;
        return { ok: true, value: storedSession(next.meta), revision: next.meta.revision };
      } catch (error) { return failure(error); }
    },
    open(options) {
      try {
        const identity = options?.identity;
        if (!identity || typeof identity.sessionId !== "string" || !identity.sessionId.trim() || typeof identity.compatibilityKey !== "string"
          || (options.mode !== "create" && options.mode !== "open")) throw new Fail("invalid_input", "Open needs a mode, sessionId and compatibilityKey");
        let config; try { config = options.config === undefined ? undefined : validateManagedConfig(options.config); } catch (error) { throw new Fail("invalid_input", String(error)); }
        if (owned) throw new Fail("owner_conflict", "Session storage already has an owner");
        if (options.mode === "create") {
          if (data) throw new Fail("already_exists", "A session already exists at this location");
          checkScriptIdentity(identity.compatibilityKey, options.requiredScriptDigest);
          data = empty({ sessionId: identity.sessionId, formatVersion: 6, createdAt: new Date().toISOString(),
            compatibilityKey: identity.compatibilityKey, lifecycle: "running", revision: 0, nextTurnId: 1, nextItemNumber: 1 });
        } else {
          if (!data) throw new Fail("not_found", "No session exists at this location");
          if (data.meta.sessionId !== identity.sessionId) throw new Fail("incompatible", "Location holds a different session");
          checkScriptIdentity(data.meta.compatibilityKey, options.requiredScriptDigest);
        }
        const tables = memoryTables(data);
        if (referencesCompatible(tables, config)) recover(tables);
        owned = true;
        return { ok: true, value: createEngine(tables, identity.compatibilityKey, () => { owned = false; }, config), revision: data.meta.revision };
      } catch (error) { return failure(error); }
    },
    importArchive(raw, options) {
      try {
        const archive = validateArchive(raw);
        if (options?.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId.trim()))
          throw new Fail("invalid_input", "sessionId must be a nonempty string");
        if (data) throw new Fail("already_exists", "A session already exists at this location");
        const next = empty(archiveMeta(copy(archive), options?.sessionId));
        restoreArchive(memoryTables(next), archive);
        data = next; // Published only after every row was written.
        return { ok: true, value: storedSession(next.meta), revision: next.meta.revision };
      } catch (error) { return failure(error); }
    },
  };
}
