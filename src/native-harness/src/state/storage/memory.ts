import type { SessionStorageAdapter, StoredItem, TimelineEntry } from "../../contracts/storage.ts";
import { Fail, createEngine, failure, recover, referencesCompatible, type ChannelRow, type Meta, type Tables, type TurnRow, type ModelState } from "./engine.ts";
import { archiveMeta, restoreArchive, storedSession, validateArchive, validateSessionPayload } from "./archive.ts";
import { validateManagedConfig } from "../../util/config.ts";

interface Data {
  modelState?: ModelState;
  config?: import("../../contracts/session-file.ts").PortableSessionConfig;
  meta: Meta;
  channels: Map<string, ChannelRow>; participants: Set<string>;
  items: Map<string, StoredItem>; turns: Map<number, TurnRow>; entries: TimelineEntry[];
}
const empty = (meta: Meta): Data => ({ meta, channels: new Map(), participants: new Set(), items: new Map(), turns: new Map(), entries: [] });
const copy = <T>(value: T): T => structuredClone(value);
const live = (turn: TurnRow) => turn.state.status === "running" || turn.state.status === "suspended";

/** Rows in maps. Each write records how to undo itself, so a throwing
 * transaction leaves no partial change without copying the whole session. */
function memoryTables(data: Data): Tables {
  let undo: (() => void)[] | undefined;
  const log = (step: () => void) => { undo?.push(step); };
  return {
    getModelState: () => copy(data.modelState),
    setModelState(state) { const old = data.modelState; log(() => { data.modelState = old; }); data.modelState = copy(state); },
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
    },
    pendingItems: channelId => copy([...data.items.values()].filter(item => item.channelId === channelId && item.milestone === "received")
      .sort((a, b) => a.acceptedSeq - b.acceptedSeq)),
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
    addEntry(entry) { data.entries.push(copy(entry)); log(() => { data.entries.pop(); }); },
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
          data = empty({ sessionId: identity.sessionId, formatVersion: 5, createdAt: new Date().toISOString(),
            compatibilityKey: identity.compatibilityKey, lifecycle: "running", revision: 0, nextTurnId: 1, nextItemNumber: 1 });
        } else {
          if (!data) throw new Fail("not_found", "No session exists at this location");
          if (data.meta.sessionId !== identity.sessionId) throw new Fail("incompatible", "Location holds a different session");
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
