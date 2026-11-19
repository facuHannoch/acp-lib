import { Database } from "bun:sqlite";
import { existsSync, linkSync, rmSync } from "node:fs";
import type { SessionStorageAdapter, StoredItem, TimelineEntry } from "../../contracts/storage.ts";
import { Fail, createEngine, failure, recover, type ChannelRow, type Meta, type Tables, type TurnRow } from "./engine.ts";
import { archiveMeta, restoreArchive, storedSession, validateArchive } from "./archive.ts";

/** Query keys are typed columns; structured payloads are JSON text. The partial
 * unique index is the durable form of "one live turn per channel". */
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE channels (channel_id TEXT PRIMARY KEY, position INTEGER NOT NULL,
  display_name TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open','suspending','suspended','retired')));
CREATE TABLE participants (participant_id TEXT PRIMARY KEY, position INTEGER NOT NULL);
CREATE TABLE turns (
  turn_id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  started_seq INTEGER NOT NULL, started_at TEXT NOT NULL, compatibility_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','suspended','completed','failed','interrupted')),
  state TEXT NOT NULL);
CREATE UNIQUE INDEX one_live_turn ON turns(channel_id) WHERE status IN ('running','suspended');
CREATE TABLE entries (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  turn_id INTEGER NOT NULL REFERENCES turns(turn_id), sender TEXT NOT NULL, kind TEXT,
  source_channel_id TEXT, item_id TEXT, message TEXT NOT NULL);
CREATE INDEX entries_by_turn ON entries(turn_id, seq);
CREATE TABLE items (
  item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  sender_id TEXT NOT NULL, source_channel_id TEXT, text TEXT NOT NULL, signature TEXT NOT NULL,
  accepted_seq INTEGER NOT NULL UNIQUE, accepted_at TEXT NOT NULL,
  milestone TEXT NOT NULL CHECK (milestone IN ('received','taken','delivered','seen','withdrawn')),
  turn_id INTEGER REFERENCES turns(turn_id), entry_seq INTEGER REFERENCES entries(seq),
  withdrawn_at TEXT,
  CHECK ((milestone IN ('received','withdrawn')) = (turn_id IS NULL)),
  CHECK ((milestone = 'withdrawn') = (withdrawn_at IS NOT NULL)));
CREATE INDEX items_pending ON items(channel_id, accepted_seq) WHERE milestone = 'received';
CREATE INDEX items_by_turn ON items(turn_id, entry_seq);
`;

/** Format 2 (persistence revision) to 3, run inside the recovery transaction by
 * `recover`, so any failure rolls everything back and leaves format 2 intact.
 * Channels gain a name and a lifecycle (existing ones are `open`); `items` is
 * rebuilt because SQLite cannot alter its CHECK constraints. */
function upgradeFromFormat2(db: Database): void {
  db.exec(`
ALTER TABLE channels ADD COLUMN display_name TEXT;
ALTER TABLE channels ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open','suspending','suspended','retired'));
DROP INDEX items_pending; DROP INDEX items_by_turn;
ALTER TABLE items RENAME TO items_v2;
CREATE TABLE items (
  item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  sender_id TEXT NOT NULL, source_channel_id TEXT, text TEXT NOT NULL, signature TEXT NOT NULL,
  accepted_seq INTEGER NOT NULL UNIQUE, accepted_at TEXT NOT NULL,
  milestone TEXT NOT NULL CHECK (milestone IN ('received','taken','delivered','seen','withdrawn')),
  turn_id INTEGER REFERENCES turns(turn_id), entry_seq INTEGER REFERENCES entries(seq),
  withdrawn_at TEXT,
  CHECK ((milestone IN ('received','withdrawn')) = (turn_id IS NULL)),
  CHECK ((milestone = 'withdrawn') = (withdrawn_at IS NOT NULL)));
INSERT INTO items SELECT item_id, kind, channel_id, sender_id, source_channel_id, text, signature, accepted_seq, accepted_at,
  milestone, turn_id, entry_seq, NULL FROM items_v2;
DROP TABLE items_v2;
CREATE INDEX items_pending ON items(channel_id, accepted_seq) WHERE milestone = 'received';
CREATE INDEX items_by_turn ON items(turn_id, entry_seq);`);
}
const NUMERIC: (keyof Meta)[] = ["formatVersion", "revision", "nextTurnId", "nextItemNumber"];
const KEYS: (keyof Meta)[] = ["sessionId", "createdAt", "compatibilityKey", "lifecycle", ...NUMERIC];

type Row = Record<string, any>;
const item = (row: Row): StoredItem => ({
  itemId: row.item_id, kind: row.kind, channelId: row.channel_id, senderId: row.sender_id,
  ...(row.source_channel_id === null ? {} : { sourceChannelId: row.source_channel_id }), text: row.text,
  signature: row.signature, acceptedSeq: row.accepted_seq, acceptedAt: row.accepted_at, milestone: row.milestone,
  ...(row.withdrawn_at === null ? {} : { withdrawnAt: row.withdrawn_at }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id, entrySeq: row.entry_seq }) });
const channel = (row: Row): ChannelRow => ({ channelId: row.channel_id,
  ...(row.display_name === null ? {} : { displayName: row.display_name }), lifecycle: row.lifecycle });
const turn = (row: Row): TurnRow => ({ turnId: row.turn_id, channelId: row.channel_id, startedSeq: row.started_seq,
  startedAt: row.started_at, compatibilityKey: row.compatibility_key, state: JSON.parse(row.state) });
const entry = (row: Row): TimelineEntry => ({ seq: row.seq, at: row.at, channelId: row.channel_id, turnId: row.turn_id, from: row.sender,
  ...(row.kind === null ? {} : { kind: row.kind }), ...(row.source_channel_id === null ? {} : { sourceChannelId: row.source_channel_id }),
  ...(row.item_id === null ? {} : { itemId: row.item_id }), message: JSON.parse(row.message) });

function sqliteTables(db: Database): Tables {
  // Prepared on first use: statements for tables a format 2 file does not have
  // yet must not be compiled before the upgrade runs.
  const q = (sql: string) => {
    let statement: ReturnType<Database["query"]> | undefined;
    const prepared = () => (statement ??= db.query<Row, any[]>(sql));
    return { get: (...args: any[]) => prepared().get(...args) as Row | null, all: (...args: any[]) => prepared().all(...args) as Row[],
      run: (...args: any[]) => { prepared().run(...args); } };
  };
  const s = {
    meta: q("SELECT key, value FROM meta"), setMeta: q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    channel: q("SELECT * FROM channels WHERE channel_id = ?"),
    addChannel: q("INSERT OR IGNORE INTO channels (channel_id, position) VALUES (?, (SELECT COUNT(*) FROM channels))"),
    putChannel: q("UPDATE channels SET display_name = ?, lifecycle = ? WHERE channel_id = ?"),
    channels: q("SELECT * FROM channels ORDER BY position"),
    addParticipant: q("INSERT OR IGNORE INTO participants VALUES (?, (SELECT COUNT(*) FROM participants))"),
    participants: q("SELECT participant_id FROM participants ORDER BY position"),
    item: q("SELECT * FROM items WHERE item_id = ?"),
    putItem: q(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET milestone = excluded.milestone, turn_id = excluded.turn_id, entry_seq = excluded.entry_seq,
        withdrawn_at = excluded.withdrawn_at`),
    pending: q("SELECT * FROM items WHERE channel_id = ? AND milestone = 'received' ORDER BY accepted_seq"),
    ofTurn: q("SELECT * FROM items WHERE turn_id = ? ORDER BY entry_seq"), items: q("SELECT * FROM items ORDER BY accepted_seq"),
    turn: q("SELECT * FROM turns WHERE turn_id = ?"),
    putTurn: q(`INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET status = excluded.status, state = excluded.state`),
    live: q("SELECT * FROM turns WHERE channel_id = ? AND status IN ('running','suspended')"), turns: q("SELECT * FROM turns ORDER BY turn_id"),
    addEntry: q("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    entriesOf: q("SELECT * FROM entries WHERE turn_id = ? ORDER BY seq"), entries: q("SELECT * FROM entries ORDER BY seq"),
  };
  let depth = 0;
  return {
    // Short and synchronous: nothing awaits between BEGIN and COMMIT.
    transaction(run) {
      if (depth) return run();
      db.exec("BEGIN IMMEDIATE"); depth++;
      try { const value = run(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { depth--; }
    },
    getMeta() {
      const meta: Row = {};
      for (const row of s.meta.all()) meta[row.key] = NUMERIC.includes(row.key) ? Number(row.value) : row.value;
      return meta as Meta;
    },
    setMeta(meta) { for (const key of KEYS) s.setMeta.run(key, String(meta[key])); },
    channel(id) { const row = s.channel.get(id); return row ? channel(row) : undefined; },
    putChannel(c) { s.addChannel.run(c.channelId); s.putChannel.run(c.displayName ?? null, c.lifecycle, c.channelId); },
    channels: () => s.channels.all().map(channel),
    addParticipant(id) { s.addParticipant.run(id); },
    participants: () => s.participants.all().map(row => row.participant_id),
    item(id) { const row = s.item.get(id); return row ? item(row) : undefined; },
    putItem(i) { s.putItem.run(i.itemId, i.kind, i.channelId, i.senderId, i.sourceChannelId ?? null, i.text, i.signature,
      i.acceptedSeq, i.acceptedAt, i.milestone, i.turnId ?? null, i.entrySeq ?? null, i.withdrawnAt ?? null); },
    pendingItems: channelId => s.pending.all(channelId).map(item),
    itemsOfTurn: turnId => s.ofTurn.all(turnId).map(item),
    items: () => s.items.all().map(item),
    turn(id) { const row = s.turn.get(id); return row ? turn(row) : undefined; },
    putTurn(t) { s.putTurn.run(t.turnId, t.channelId, t.startedSeq, t.startedAt, t.compatibilityKey, t.state.status, JSON.stringify(t.state)); },
    liveTurn(channelId) { const row = s.live.get(channelId); return row ? turn(row) : undefined; },
    turns: () => s.turns.all().map(turn),
    addEntry(e) { s.addEntry.run(e.seq, e.at, e.channelId, e.turnId, e.from, e.kind ?? null, e.sourceChannelId ?? null,
      e.itemId ?? null, JSON.stringify(e.message)); },
    entriesOfTurn: turnId => s.entriesOf.all(turnId).map(entry),
    entries: () => s.entries.all().map(entry),
  };
}

/** Build a complete database beside the destination, then publish it with a
 * hard link, which fails if the destination exists. A crash leaves either no
 * session or a whole one, never a partial file at `path`. */
function publish(path: string, meta: Meta, fill?: (tables: Tables) => void): void {
  if (existsSync(path)) throw new Fail("already_exists", `A session already exists at ${path}`);
  const draft = `${path}.draft-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    const db = new Database(draft, { readwrite: true, create: true });
    try {
      db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      const tables = sqliteTables((db.exec(SCHEMA), db));
      tables.transaction(() => { tables.setMeta(meta); fill?.(tables); });
    } finally { db.close(); }
    try { linkSync(draft, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Fail("already_exists", `A session already exists at ${path}`);
      throw error;
    }
  } finally { rmSync(draft, { force: true }); rmSync(`${draft}-journal`, { force: true }); }
}

/** One SQLite file holds one session. Ownership is SQLite's exclusive file
 * lock, held from open to close: a second handle, in this or any process,
 * fails immediately, and the operating system releases it if the owner dies. */
export function createSqliteStorageAdapter(path: string): SessionStorageAdapter {
  return {
    open(options) {
      let db: Database | undefined;
      try {
        const identity = options?.identity;
        if (!identity || typeof identity.sessionId !== "string" || !identity.sessionId.trim() || typeof identity.compatibilityKey !== "string"
          || (options.mode !== "create" && options.mode !== "open")) throw new Fail("invalid_input", "Open needs a mode, sessionId and compatibilityKey");
        if (options.mode === "create") publish(path, { sessionId: identity.sessionId, formatVersion: 3, createdAt: new Date().toISOString(),
          compatibilityKey: identity.compatibilityKey, lifecycle: "running", revision: 0, nextTurnId: 1, nextItemNumber: 1 });
        else if (!existsSync(path)) throw new Fail("not_found", `No session exists at ${path}`);
        db = new Database(path, { readwrite: true, create: false });
        // Take the lock first, then validate, and only then let recovery write.
        db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
        db.exec("BEGIN EXCLUSIVE");
        let meta: Meta;
        try {
          meta = sqliteTables(db).getMeta();
        } catch { throw new Fail("incompatible", "File is not a readable harness session"); }
        finally { db.exec("ROLLBACK"); }
        if (meta.formatVersion !== 2 && meta.formatVersion !== 3) throw new Fail("incompatible", `Unsupported storage format: ${meta.formatVersion}`);
        if (meta.sessionId !== identity.sessionId) throw new Fail("incompatible", "File holds a different session");
        const tables = sqliteTables(db), owner = db;
        recover(tables, meta.formatVersion === 2 ? () => upgradeFromFormat2(owner) : undefined);
        return { ok: true, value: createEngine(tables, identity.compatibilityKey, () => owner.close()), revision: tables.getMeta().revision };
      } catch (error) {
        try { db?.close(); } catch { /* The original failure is the one to report. */ }
        const code = (error as { code?: string }).code;
        if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return failure(new Fail("owner_conflict", "Session storage already has an owner"));
        if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return failure(new Fail("incompatible", "File is not a readable harness session"));
        return failure(error);
      }
    },
    importArchive(raw, options) {
      try {
        const archive = validateArchive(raw);
        if (options?.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId.trim()))
          throw new Fail("invalid_input", "sessionId must be a nonempty string");
        const meta = archiveMeta(archive, options?.sessionId);
        publish(path, meta, tables => restoreArchive(tables, archive));
        return { ok: true, value: storedSession(meta), revision: meta.revision };
      } catch (error) { return failure(error); }
    },
  };
}
