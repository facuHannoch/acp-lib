import { sqliteWebTables } from "./web-tables.ts";
import { bindUnattendedGuard, checkUnattendedGuard } from "./engine.ts";
import { sqliteReminderTables } from "./sqlite-reminders.ts";
import { sqliteAttachmentTables } from "./attachment-tables.ts";
import { readArchiveFiles } from "./attachment-files.ts";
import { acquireImportLease, publishAttachmentImport, recoverAttachmentImport } from "./attachment-import.ts";
import { historicalCandidate, historicalRetrievalProjection, encodedTimelineToken, retrievalMessage, timelineBytes, timelineIndexText } from "../../util/timeline-text.ts";
import type { ModelCallSummary } from "../../contracts/model-execution.ts";
import { entryOverhead, type ContextRow } from "./inference.ts";
import { checkScriptIdentity } from "./script-identity.ts";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, rmSync } from "node:fs";
import type { PortableSessionConfig } from "../../contracts/session-file.ts";
import type { SessionStorageAdapter, StorageResult, StoredItem, TimelineEntry } from "../../contracts/storage.ts";
import { Fail, createEngine, failure, recover, referencesCompatible, type ChannelRow, type Meta, type Tables, type TurnRow } from "./engine.ts";
import { archiveMeta, restoreArchive, storedSession, validateArchive, validateSessionPayload } from "./archive.ts";
import { legacyItemSignature, policyItemSignature } from "./policy-metadata.ts";
import { validateManagedConfig } from "../../util/config.ts";

/** Query keys are typed columns; structured payloads are JSON text. The partial
 * unique index is the durable form of "one live turn per channel". */
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE channels (channel_id TEXT PRIMARY KEY, position INTEGER NOT NULL,
  display_name TEXT, policy TEXT,
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
  source_channel_id TEXT, item_id TEXT, message TEXT NOT NULL, external_source TEXT);
CREATE INDEX entries_by_turn ON entries(turn_id, seq);
CREATE TABLE items (
  item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  sender_id TEXT NOT NULL, source_channel_id TEXT, text TEXT NOT NULL, signature TEXT NOT NULL,
  accepted_seq INTEGER NOT NULL UNIQUE, accepted_at TEXT NOT NULL,
  milestone TEXT NOT NULL CHECK (milestone IN ('received','taken','delivered','seen','withdrawn')),
  turn_id INTEGER REFERENCES turns(turn_id), entry_seq INTEGER REFERENCES entries(seq),
  withdrawn_at TEXT, policy_metadata TEXT NOT NULL, external_source TEXT,
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
/** Rewrite legacy identities before the new policy-aware engine can read them.
 * The caller owns the recovery transaction, so a bad signature rolls back the
 * schema and all row updates together. */
function upgradeFromFormat3(db: Database): void {
  db.exec("ALTER TABLE channels ADD COLUMN policy TEXT; ALTER TABLE items ADD COLUMN policy_metadata TEXT");
  const rows = db.query<Row, []>("SELECT * FROM items").all();
  const update = db.query("UPDATE items SET signature = ?, policy_metadata = ? WHERE item_id = ?");
  for (const row of rows) {
    const input = { kind: row.kind, channelId: row.channel_id, senderId: row.sender_id,
      ...(row.source_channel_id === null ? {} : { sourceChannelId: row.source_channel_id }), text: row.text };
    if (row.signature !== legacyItemSignature(input)) throw new Fail("incompatible", `Invalid legacy item signature: ${row.item_id}`);
    update.run(policyItemSignature(input), JSON.stringify({ resolved: "__legacy_allow", inherited: [] }), row.item_id);
  }
  const turns = db.query<Row, []>("SELECT turn_id, state FROM turns WHERE status = 'suspended'").all();
  const updateTurn = db.query("UPDATE turns SET state = ? WHERE turn_id = ?");
  for (const turn of turns) {
    const state = JSON.parse(turn.state); state.checkpoint.policyFingerprint = JSON.stringify([["__legacy_allow", "allow", []]]);
    updateTurn.run(JSON.stringify(state), turn.turn_id);
  }
}
function addExternalSource(db: Database): void {
  db.exec("ALTER TABLE items ADD COLUMN external_source TEXT; ALTER TABLE entries ADD COLUMN external_source TEXT");
}
const NUMERIC: (keyof Meta)[] = ["formatVersion", "revision", "nextTurnId", "nextItemNumber"];
const KEYS: (keyof Meta)[] = ["sessionId", "createdAt", "compatibilityKey", "lifecycle", ...NUMERIC];

type Row = Record<string, any>;
const item = (row: Row): StoredItem => ({
  itemId: row.item_id, kind: row.kind, channelId: row.channel_id, senderId: row.sender_id,
  ...(row.source_channel_id === null ? {} : { sourceChannelId: row.source_channel_id }), text: row.text,
  ...(row.external_source == null ? {} : { externalSource: row.external_source }),
  ...(row.kind === "external_notice" ? { inheritedPolicyNames: JSON.parse(row.policy_metadata).inherited } : {}),
  signature: row.signature, acceptedSeq: row.accepted_seq, acceptedAt: row.accepted_at, milestone: row.milestone,
  policy: JSON.parse(row.policy_metadata),
  ...(JSON.parse(row.policy_metadata).explicit === undefined ? {} : { explicitPolicy: JSON.parse(row.policy_metadata).explicit }),
  ...(row.withdrawn_at === null ? {} : { withdrawnAt: row.withdrawn_at }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id, entrySeq: row.entry_seq }) });
const channel = (row: Row): ChannelRow => ({ channelId: row.channel_id,
  ...(row.display_name === null ? {} : { displayName: row.display_name }), ...(row.policy === null ? {} : { policy: row.policy }), lifecycle: row.lifecycle });
const turn = (row: Row): TurnRow => ({ turnId: row.turn_id, channelId: row.channel_id, startedSeq: row.started_seq,
  startedAt: row.started_at, compatibilityKey: row.compatibility_key, state: JSON.parse(row.state) });
const entry = (row: Row): TimelineEntry => ({ seq: row.seq, at: row.at, channelId: row.channel_id, turnId: row.turn_id, from: row.sender,
  ...(row.external_source == null ? {} : { externalSource: row.external_source }),
  ...(row.kind === null ? {} : { kind: row.kind }), ...(row.source_channel_id === null ? {} : { sourceChannelId: row.source_channel_id }),
  ...(row.item_id === null ? {} : { itemId: row.item_id }), ...(typeof row.reply_id === "string" ? { messageId: row.reply_id } : {}), message: JSON.parse(row.message) });

const ASSISTANT = "json_extract(message, '$.role') = 'assistant'";
const REPLY = `${ASSISTANT} AND length(json_extract(message, '$.content')) > 0`;
const CONTEXT_BYTES = `${entryOverhead} + octet_length(message) + octet_length(at) +
  octet_length(e.channel_id) + octet_length(sender) + coalesce(octet_length(kind), 0) +
  coalesce(octet_length(source_channel_id), 0) + coalesce(octet_length(item_id), 0) +
  coalesce(octet_length(external_source), 0) + coalesce(
    (SELECT octet_length(message_id) FROM entry_reply_ids WHERE seq = e.seq), 0)`;
const contextHeader = (kind: string, legacy = false) =>
  `e.seq, ${legacy ? CONTEXT_BYTES.replace("coalesce(octet_length(external_source), 0)", "0") : CONTEXT_BYTES} AS bytes, ${kind} AS kind`;
const historyHeader = () => contextHeader("'other'").replace("octet_length(message)",
  "coalesce((SELECT octet_length(message) FROM retrieval_history_projection WHERE seq = e.seq), octet_length(e.message))");
const contextRow = (row: Row): ContextRow => ({ seq: row.seq, bytes: row.bytes, kind: row.kind, ...(row.text_bytes === undefined ? {} : { textBytes: row.text_bytes }) });
const CHAT = `kind = 'participant_message' OR (${REPLY})`;
const installReadIndexes = (db: Database) => db.exec(`
  CREATE INDEX IF NOT EXISTS turns_by_channel ON turns(channel_id, turn_id);
  CREATE INDEX IF NOT EXISTS entries_conversation ON entries(channel_id, seq) WHERE ${CHAT};
  CREATE INDEX IF NOT EXISTS entries_context_inputs ON entries(turn_id, seq) WHERE item_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS entries_context_assistants ON entries(turn_id, seq) WHERE ${ASSISTANT};
  CREATE INDEX IF NOT EXISTS entries_replies ON entries(turn_id, seq) WHERE ${REPLY};
  CREATE TABLE IF NOT EXISTS entry_reply_ids (seq INTEGER PRIMARY KEY REFERENCES entries(seq), message_id TEXT NOT NULL);
  INSERT OR IGNORE INTO meta VALUES ('replyIdsDirty', '1');
  CREATE TRIGGER IF NOT EXISTS reply_ids_legacy_insert AFTER INSERT ON meta WHEN NEW.key = 'modelState'
    BEGIN UPDATE meta SET value = '1' WHERE key = 'replyIdsDirty'; END;
  CREATE TRIGGER IF NOT EXISTS reply_ids_legacy_update AFTER UPDATE OF value ON meta WHEN NEW.key = 'modelState'
    BEGIN UPDATE meta SET value = '1' WHERE key = 'replyIdsDirty'; END;
`);

// Projection version is in the key so a future tokenizer can rebuild without
// changing the canonical session or archive format.
function refreshRetrieval(db: Database, entries: () => TimelineEntry[]): void {
  db.exec(`
    INSERT OR IGNORE INTO meta VALUES ('timelineRetrievalV1Dirty', '1');
    UPDATE meta SET value = '1' WHERE key = 'timelineRetrievalV1Dirty'
      AND (NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'timeline_retrieval_v1')
        OR NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'retrieval_history_candidates'));
    CREATE VIRTUAL TABLE IF NOT EXISTS timeline_retrieval_v1 USING fts5(tokens, channel UNINDEXED, bytes UNINDEXED, tokenize = ascii);
    CREATE TABLE IF NOT EXISTS retrieval_history_projection (seq INTEGER PRIMARY KEY, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retrieval_history_candidates (seq INTEGER PRIMARY KEY, channel_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retrieval_history_calls (turn_id INTEGER NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY(turn_id, call_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS reverse_entry_reply_ids ON entry_reply_ids(message_id);
    CREATE TRIGGER IF NOT EXISTS timeline_retrieval_insert AFTER INSERT ON entries
      BEGIN UPDATE meta SET value = '1' WHERE key = 'timelineRetrievalV1Dirty'; END;
    CREATE TRIGGER IF NOT EXISTS timeline_retrieval_update AFTER UPDATE ON entries
      BEGIN UPDATE meta SET value = '1' WHERE key = 'timelineRetrievalV1Dirty'; END;
    CREATE TRIGGER IF NOT EXISTS timeline_retrieval_delete AFTER DELETE ON entries
      BEGIN UPDATE meta SET value = '1' WHERE key = 'timelineRetrievalV1Dirty'; END;
  `);
  const dirty = db.prepare("SELECT value FROM meta WHERE key = 'timelineRetrievalV1Dirty'");
  try { if ((dirty.get() as { value: string }).value === "0") return; }
  finally { dirty.finalize(); }
  db.exec("DELETE FROM timeline_retrieval_v1; DELETE FROM retrieval_history_projection; DELETE FROM retrieval_history_candidates; DELETE FROM retrieval_history_calls");
  const insert = db.prepare("INSERT INTO timeline_retrieval_v1(rowid, tokens, channel, bytes) VALUES (?, ?, ?, ?)");
  const history = db.prepare("INSERT INTO retrieval_history_projection VALUES (?, ?)");
  const candidate = db.prepare("INSERT INTO retrieval_history_candidates VALUES (?, ?)");
  const register = db.prepare("INSERT OR IGNORE INTO retrieval_history_calls VALUES (?, ?)");
  const contains = db.prepare("SELECT 1 FROM retrieval_history_calls WHERE turn_id = ? AND call_id = ?");
  try {
    for (const entry of entries()) {
      if (historicalCandidate(entry.message, id => register.run(entry.turnId, id), id => !!contains.get(entry.turnId, id)))
        candidate.run(entry.seq, entry.channelId);
      const message = retrievalMessage(entry);
      if (message) {
        insert.run(message.seq, timelineIndexText(message.text), message.channel, timelineBytes(message.text));
        const projected = historicalRetrievalProjection(entry.message);
        if (projected !== entry.message) history.run(entry.seq, JSON.stringify(projected));
      }
    }
  } finally { insert.finalize(); history.finalize(); candidate.finalize(); register.finalize(); contains.finalize(); }
  db.exec("UPDATE meta SET value = '0' WHERE key = 'timelineRetrievalV1Dirty'");
}

const rebuildModelCalls = (db: Database) => db.exec(`
  DELETE FROM model_call_pages;
  INSERT INTO model_call_pages
    SELECT CAST(json_extract(call.value, '$.callId') AS INTEGER), call.value
    FROM meta, json_each(meta.value, '$.calls') AS call WHERE meta.key = 'modelState';
  UPDATE meta SET value = '0' WHERE key = 'modelCallPagesDirty';
`);

function refreshModelCalls(db: Database): void {
  db.exec(`
    INSERT OR IGNORE INTO meta VALUES ('modelCallPagesDirty', '1');
    UPDATE meta SET value = '1' WHERE key = 'modelCallPagesDirty'
      AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'model_call_pages');
    CREATE TABLE IF NOT EXISTS model_call_pages (call_number INTEGER PRIMARY KEY, summary TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS model_calls_legacy_insert AFTER INSERT ON meta WHEN NEW.key = 'modelState'
      BEGIN UPDATE meta SET value = '1' WHERE key = 'modelCallPagesDirty'; END;
    CREATE TRIGGER IF NOT EXISTS model_calls_legacy_update AFTER UPDATE OF value ON meta WHEN NEW.key = 'modelState'
      BEGIN UPDATE meta SET value = '1' WHERE key = 'modelCallPagesDirty'; END;
  `);
  const dirty = db.prepare("SELECT value FROM meta WHERE key = 'modelCallPagesDirty'");
  try { if ((dirty.get() as { value: string }).value === "1") rebuildModelCalls(db); }
  finally { dirty.finalize(); }
}

// Older writers keep the blob authoritative. Rebuild only on upgrade or when
// one of those writers changed it, under the same transaction as recovery.
function refreshReplyIds(db: Database): void {
  installReadIndexes(db);
  const dirty = db.prepare("SELECT 1 FROM meta WHERE key = 'replyIdsDirty' AND value = '1'");
  try { if (!dirty.get()) return; } finally { dirty.finalize(); }
  db.exec(`
    DELETE FROM entry_reply_ids;
    INSERT INTO entry_reply_ids
      SELECT CAST(ids.key AS INTEGER), ids.value FROM meta, json_each(meta.value, '$.entryIds') AS ids
      WHERE meta.key = 'modelState';
    UPDATE meta SET value = '0' WHERE key = 'replyIdsDirty';
  `);
}

/** Backfill once under the owner transaction. Triggers keep the projection
 * current even when an older format-6 writer subsequently takes input. */
function installContextPolicyIndex(db: Database): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'context_turn_policies'");
  try { if (exists.get()) return; } finally { exists.finalize(); }
  const project = `
    INSERT INTO context_turn_policies
      SELECT NEW.turn_id, coalesce(json_extract(NEW.policy_metadata, '$.resolved'), '__legacy_allow')
      UNION ALL SELECT NEW.turn_id, value FROM json_each(NEW.policy_metadata, '$.inherited') WHERE true
      ON CONFLICT(turn_id, name) DO NOTHING;`;
  db.exec(`
    CREATE TABLE context_turn_policies (
      turn_id INTEGER NOT NULL REFERENCES turns(turn_id), name TEXT NOT NULL, PRIMARY KEY (turn_id, name)
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO context_turn_policies
      SELECT turn_id, coalesce(json_extract(policy_metadata, '$.resolved'), '__legacy_allow') FROM items WHERE turn_id IS NOT NULL
      UNION ALL SELECT turn_id, value FROM items, json_each(items.policy_metadata, '$.inherited') WHERE turn_id IS NOT NULL;
    CREATE TRIGGER context_policy_insert AFTER INSERT ON items WHEN NEW.turn_id IS NOT NULL
      BEGIN ${project} END;
    CREATE TRIGGER context_policy_take AFTER UPDATE OF turn_id ON items WHEN OLD.turn_id IS NULL AND NEW.turn_id IS NOT NULL
      BEGIN ${project} END;
  `);
}

function sqliteTables(db: Database): Tables & { dispose(): void } {
  const attachments = sqliteAttachmentTables(db);
  const web = sqliteWebTables(db);
  const readItem = (row: Row): StoredItem => {
    const value = item(row), parts = attachments.parts(value.itemId);
    return parts ? { ...value, parts } : value;
  };
  // Prepared on first use: statements for tables a format 2 file does not have
  // yet must not be compiled before the upgrade runs.
  const finalizers: (() => void)[] = [];
  const q = (sql: string) => {
    let statement: ReturnType<Database["query"]> | undefined;
    const prepared = () => {
      if (!statement) { statement = db.query<Row, any[]>(sql); const current = statement; finalizers.push(() => current.finalize()); }
      return statement;
    };
    return { get: (...args: any[]) => prepared().get(...args) as Row | null, all: (...args: any[]) => prepared().all(...args) as Row[],
      run: (...args: any[]) => { prepared().run(...args); } };
  };
  const s = {
    retrievalDirty: q("SELECT value FROM meta WHERE key = 'timelineRetrievalV1Dirty'"),
    retrievalReplyDirty: q("SELECT value FROM meta WHERE key = 'replyIdsDirty'"),
    retrievalClean: q("UPDATE meta SET value = '0' WHERE key = 'timelineRetrievalV1Dirty'"),
    retrievalAll: q("SELECT rowid AS seq, bytes FROM timeline_retrieval_v1 WHERE timeline_retrieval_v1 MATCH ? ORDER BY rowid DESC LIMIT ?"),
    retrievalChannel: q("SELECT rowid AS seq, bytes FROM timeline_retrieval_v1 WHERE timeline_retrieval_v1 MATCH ? AND channel = ? ORDER BY rowid DESC LIMIT ?"),
    retrievalReverse: q("SELECT seq FROM entry_reply_ids WHERE message_id = ?"),
    historicalCandidate: q("INSERT INTO retrieval_history_candidates VALUES (?, ?)"),
    historicalRegister: q("INSERT OR IGNORE INTO retrieval_history_calls VALUES (?, ?)"),
    historicalContains: q("SELECT 1 FROM retrieval_history_calls WHERE turn_id = ? AND call_id = ?"),
    historicalInsert: q("INSERT INTO retrieval_history_projection VALUES (?, ?)"),
    historicalEntry: q(`SELECT e.seq, e.at, e.channel_id, e.turn_id, e.sender, e.kind, e.source_channel_id, e.item_id, e.external_source,
      coalesce((SELECT message FROM retrieval_history_projection WHERE seq = e.seq), e.message) AS message,
      (SELECT message_id FROM entry_reply_ids WHERE seq = e.seq) AS reply_id FROM entries AS e WHERE e.seq = ?`),
    retrievalInsert: q("INSERT INTO timeline_retrieval_v1(rowid, tokens, channel, bytes) VALUES (?, ?, ?, ?)"),
    modelCallPagesDirty: q("SELECT value FROM meta WHERE key = 'modelCallPagesDirty'"),
    callCursor: q("SELECT call_number FROM model_call_pages WHERE call_number = ?"),
    callPage: q("SELECT summary FROM model_call_pages WHERE call_number > ? ORDER BY call_number LIMIT ?"),
    putCallPage: q(`INSERT INTO model_call_pages VALUES (?, ?)
      ON CONFLICT(call_number) DO UPDATE SET summary = excluded.summary`),
    markCallPagesClean: q("UPDATE meta SET value = '0' WHERE key = 'modelCallPagesDirty'"),
    contextTurnStart: q("SELECT started_seq FROM turns WHERE turn_id = ? AND channel_id = ?"),
    contextTrigger: q(`SELECT ${contextHeader("'input'")}, (SELECT octet_length(text) FROM items WHERE items.item_id = e.item_id) AS text_bytes FROM entries AS e
      WHERE turn_id = ? AND item_id IS NOT NULL ORDER BY seq LIMIT 1`),
    contextPreviousResponse: q(`SELECT seq FROM entries WHERE turn_id = ? AND ${ASSISTANT} ORDER BY seq DESC LIMIT 1`),
    contextInputs: q(`SELECT ${contextHeader("'input'")}, (SELECT octet_length(text) FROM items WHERE items.item_id = e.item_id) AS text_bytes FROM entries AS e
      WHERE turn_id = ? AND item_id IS NOT NULL AND seq > ? ORDER BY seq LIMIT ?`),
    contextAttachmentInputs: q(`SELECT ${contextHeader("'input'")}, (SELECT octet_length(text) FROM items WHERE items.item_id = e.item_id) AS text_bytes FROM entries AS e
      WHERE turn_id = ? AND item_id IS NOT NULL AND json_type(message, '$.parts') = 'array' ORDER BY seq DESC LIMIT ?`),
    contextActive: q(`SELECT ${contextHeader(`CASE WHEN item_id IS NOT NULL THEN 'input'
      WHEN EXISTS (SELECT 1 FROM entries AS a INDEXED BY entries_context_assistants
        WHERE a.turn_id = e.turn_id AND a.seq = e.seq AND ${ASSISTANT}) THEN 'assistant' ELSE 'other' END`)}
      FROM entries AS e WHERE turn_id = ? ORDER BY seq DESC LIMIT ?`),
    contextLocal: q(`SELECT ${historyHeader()} FROM entries AS e
      WHERE channel_id = ? AND seq < ? AND (${CHAT}) ORDER BY seq DESC LIMIT ?`),
    contextRecent: q(`SELECT ${contextHeader("'other'")} FROM entries AS e WHERE seq < ? ORDER BY seq DESC LIMIT ?`),
    contextRecentLegacy: q(`SELECT ${contextHeader("'other'", true)} FROM entries AS e WHERE seq < ? ORDER BY seq DESC LIMIT ?`),
    contextShared: q(`WITH recent AS MATERIALIZED (
        SELECT seq, channel_id FROM retrieval_history_candidates ORDER BY seq DESC LIMIT ?)
      SELECT ${historyHeader()} FROM recent JOIN entries AS e ON e.seq = recent.seq
      WHERE recent.channel_id <> ? AND EXISTS (
        SELECT 1 FROM entries AS c INDEXED BY entries_conversation
        WHERE c.channel_id = recent.channel_id AND c.seq = recent.seq AND (${CHAT}))
      ORDER BY e.seq DESC`),
    contextPolicySize: q(`SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM (
        SELECT octet_length(name) + 1 AS bytes FROM context_turn_policies WHERE turn_id = ? LIMIT ?
      )`),
    contextPolicies: q("SELECT name FROM context_turn_policies WHERE turn_id = ? ORDER BY name LIMIT ?"),
    contextUnfinishedSize: q(`SELECT ${entryOverhead} + octet_length(channel_id) + octet_length(state) AS bytes
      FROM turns WHERE turn_id = ? AND status IN ('failed', 'interrupted')`),
    contextUnfinished: q("SELECT channel_id, state FROM turns WHERE turn_id = ?"),
    contextEntry: q(`SELECT *, (SELECT message_id FROM entry_reply_ids WHERE seq = e.seq) AS reply_id
      FROM entries AS e WHERE e.seq = ?`),
    pendingCount: q("SELECT count(*) AS n FROM items WHERE channel_id = ? AND milestone = 'received'"),
    latestTurn: q("SELECT * FROM turns WHERE channel_id = ? ORDER BY turn_id DESC LIMIT 1"),
    liveTurns: q("SELECT * FROM turns WHERE status IN ('running','suspended') ORDER BY turn_id"),
    policyNames: q(`
      SELECT policy AS name FROM channels WHERE policy IS NOT NULL
      UNION SELECT coalesce(json_extract(policy_metadata, '$.resolved'), '__legacy_allow') FROM items
      UNION SELECT inherited.value FROM items, json_each(items.policy_metadata, '$.inherited') AS inherited
    `),

    meta: q(`SELECT key, value FROM meta WHERE key IN (${KEYS.map(() => "?").join(", ")})`), modelState: q("SELECT value FROM meta WHERE key = 'modelState'"), revoked: q("SELECT value FROM meta WHERE key = 'revokedTools'"), config: q("SELECT value FROM meta WHERE key = 'importedConfig'"), setMeta: q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    channel: q("SELECT * FROM channels WHERE channel_id = ?"),
    addChannel: q("INSERT OR IGNORE INTO channels (channel_id, position) VALUES (?, (SELECT COUNT(*) FROM channels))"),
    putChannel: q("UPDATE channels SET display_name = ?, lifecycle = ?, policy = ? WHERE channel_id = ?"),
    channels: q("SELECT * FROM channels ORDER BY position"),
    addParticipant: q("INSERT OR IGNORE INTO participants VALUES (?, (SELECT COUNT(*) FROM participants))"),
    participants: q("SELECT participant_id FROM participants ORDER BY position"),
    item: q("SELECT * FROM items WHERE item_id = ?"),
    putItem: q(`INSERT INTO items (item_id, kind, channel_id, sender_id, source_channel_id, text, signature, accepted_seq, accepted_at, milestone, turn_id, entry_seq, withdrawn_at, policy_metadata, external_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET milestone = excluded.milestone, turn_id = excluded.turn_id, entry_seq = excluded.entry_seq,
        withdrawn_at = excluded.withdrawn_at, signature = excluded.signature, policy_metadata = excluded.policy_metadata`),
    pending: q("SELECT * FROM items WHERE channel_id = ? AND milestone = 'received' ORDER BY accepted_seq LIMIT ?"),
    ofTurn: q("SELECT * FROM items WHERE turn_id = ? ORDER BY entry_seq"), items: q("SELECT * FROM items ORDER BY accepted_seq"),
    turn: q("SELECT * FROM turns WHERE turn_id = ?"),
    putTurn: q(`INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET status = excluded.status, state = excluded.state`),
    live: q("SELECT * FROM turns WHERE channel_id = ? AND status IN ('running','suspended')"), turns: q("SELECT * FROM turns ORDER BY turn_id"),
    markReplyIdsClean: q("UPDATE meta SET value = '0' WHERE key = 'replyIdsDirty'"),
    addReplyId: q("INSERT INTO entry_reply_ids VALUES (?, ?)"),
    addEntry: q("INSERT INTO entries (seq, at, channel_id, turn_id, sender, kind, source_channel_id, item_id, message, external_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    entriesOf: q("SELECT * FROM entries WHERE turn_id = ? ORDER BY seq"), entries: q("SELECT * FROM entries ORDER BY seq"),
  };
  let depth = 0;
  const retrievalReady = () => {
    if (s.retrievalDirty.get()?.value !== "0" || s.retrievalReplyDirty.get()?.value !== "0") {
      throw new Fail("storage_failure", "Timeline retrieval projection requires reopen");
    }
  };
  return {
    web,
    attachments,
    reminders: sqliteReminderTables(db),
    contextTurnStart: (channelId, turnId) => s.contextTurnStart.get(turnId, channelId)?.started_seq,
    contextTrigger(turnId) {
      const row = s.contextTrigger.get(turnId);
      return row ? contextRow(row) : undefined;
    },
    contextPreviousResponse: turnId => s.contextPreviousResponse.get(turnId)?.seq ?? 0,
    contextInputs: (turnId, after, limit) => s.contextInputs.all(turnId, after, limit).map(contextRow),
    contextAttachmentInputs: (turnId, limit) => s.contextAttachmentInputs.all(turnId, limit).reverse().map(contextRow),
    contextActive: (turnId, limit) => s.contextActive.all(turnId, limit).map(contextRow),
    contextLocal: (channelId, start, limit) => s.contextLocal.all(channelId, start, limit).map(contextRow),
    contextRecent: (before, limit, legacy) => (legacy ? s.contextRecentLegacy : s.contextRecent).all(before, limit).map(contextRow),
    contextShared: (channelId, limit) => s.contextShared.all(limit, channelId).map(contextRow),
    contextPolicies(turnId, limit, budget) {
      const { count, bytes } = s.contextPolicySize.get(turnId, limit + 1)!;
      if (count > limit || bytes > budget) return undefined;
      return { names: s.contextPolicies.all(turnId, count).map(row => String(row.name)).sort(), bytes };
    },
    contextUnfinished(turnId, budget) {
      const size = s.contextUnfinishedSize.get(turnId);
      if (!size || size.bytes > budget) return undefined;
      const row = s.contextUnfinished.get(turnId)!;
      return { outcome: { turnId, channelId: row.channel_id, state: JSON.parse(row.state) }, bytes: size.bytes };
    },
    contextEntry: seq => entry(s.contextEntry.get(seq)!),
    contextHistoricalEntry: seq => entry(s.historicalEntry.get(seq)!),
    pendingCount(id) {
      return Number(s.pendingCount.get(id)?.n ?? 0);
    },
    readRange(range) {
      const older = range.direction === "older";
      const order = older ? "DESC" : "ASC";
      const read = (filter: string, params: (string | number)[]) => {
        const statement = db.prepare<Row, (string | number)[]>(`
        SELECT *, (SELECT message_id FROM entry_reply_ids WHERE entry_reply_ids.seq = entries.seq) AS reply_id FROM entries WHERE (${filter}) AND seq <= ? AND seq ${older ? "<" : ">"} ?
        ORDER BY seq ${order} LIMIT ?
      `);
        try { return statement.all(...params, range.throughRevision, range.exclusiveSeq ?? (older ? Number.MAX_SAFE_INTEGER : 0), range.limit + 1).map(entry); } finally { statement.finalize(); }
      };
      if (range.kind === "conversation") return read(`channel_id = ? AND (${CHAT})`, [range.channel!]);
      if (range.kind === "replies") return (range.turnIds ?? []).flatMap(id => read(`turn_id = ? AND channel_id = ? AND ${REPLY}`, [id, range.channel!]))
        .sort((a, b) => older ? b.seq - a.seq : a.seq - b.seq).slice(0, range.limit + 1);
      return read("1", []);
    },
    retrievalCandidates(terms, channel, limit) {
      retrievalReady();
      const query = terms.map(encodedTimelineToken).join(" AND ");
      const rows = channel === undefined ? s.retrievalAll.all(query, limit) : s.retrievalChannel.all(query, channel, limit);
      return rows.map(row => ({ seq: row.seq, bytes: row.bytes }));
    },
    retrievalEntry(seq) {
      retrievalReady();
      const row = s.contextEntry.get(seq);
      return row ? entry(row) : undefined;
    },
    retrievalReplyId(id) { retrievalReady(); return s.retrievalReverse.get(id)?.seq; },
    dispose() { for (const finalize of finalizers.splice(0)) finalize(); },
    getModelState() { const row = s.modelState.get(); return row ? JSON.parse(row.value) : undefined; },
    setModelState(state, changed) {
      const canPatch = changed !== undefined && s.modelCallPagesDirty.get()?.value === "0";
      s.setMeta.run("modelState", JSON.stringify(state));
      s.markReplyIdsClean.run();
      if (canPatch) {
        for (const call of changed) s.putCallPage.run(Number(call.callId), JSON.stringify(call));
        s.markCallPagesClean.run();
      } else rebuildModelCalls(db);
    },
    modelCallPage(after, count) {
      if (s.modelCallPagesDirty.get()?.value !== "0") throw new Fail("storage_failure", "Model call page projection requires reopen");
      const cursor = after === undefined ? 0 : Number(after);
      if (after !== undefined && (!Number.isSafeInteger(cursor) || String(cursor) !== after || !s.callCursor.get(cursor))) {
        throw new Fail("not_found", "Unknown model call cursor");
      }
      return s.callPage.all(cursor, count).map(row => JSON.parse(row.summary) as ModelCallSummary);
    },
    // A meta key, like the model state: no schema or format change (decision 0021).
    getRevokedTools() { const row = s.revoked.get(); return row ? JSON.parse(row.value) : undefined; },
    setRevokedTools(names) { s.setMeta.run("revokedTools", JSON.stringify(names)); },
    getConfig() { const row = s.config.get(); return row ? JSON.parse(row.value) : undefined; },
    setConfig(config) { s.setMeta.run("importedConfig", JSON.stringify(config)); },
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
      for (const row of s.meta.all(...KEYS)) meta[row.key] = NUMERIC.includes(row.key) ? Number(row.value) : row.value;
      return meta as Meta;
    },
    setMeta(meta) { for (const key of KEYS) s.setMeta.run(key, String(meta[key])); },
    channel(id) { const row = s.channel.get(id); return row ? channel(row) : undefined; },
    putChannel(c) { s.addChannel.run(c.channelId); s.putChannel.run(c.displayName ?? null, c.lifecycle, c.policy ?? null, c.channelId); },
    channels: () => s.channels.all().map(channel),
    addParticipant(id) { s.addParticipant.run(id); },
    participants: () => s.participants.all().map(row => row.participant_id),
    item(id) { const row = s.item.get(id); return row ? readItem(row) : undefined; },
    putItem(i) { s.putItem.run(i.itemId, i.kind, i.channelId, i.senderId, i.sourceChannelId ?? null, i.text, i.signature,
      i.acceptedSeq, i.acceptedAt, i.milestone, i.turnId ?? null, i.entrySeq ?? null, i.withdrawnAt ?? null, JSON.stringify(i.policy ?? { resolved: "__legacy_allow", inherited: [] }), i.externalSource ?? null); },
    hasOpenRoutineNotice: (channelId, source) => !!db.query(`SELECT 1 FROM items i LEFT JOIN turns t USING(turn_id)
      WHERE i.channel_id = ? AND i.external_source = ? AND i.kind = 'external_notice'
      AND (i.milestone = 'received' OR t.status IN ('running','suspended')) LIMIT 1`).get(channelId, source),
    pendingItems: (channelId, limit) => s.pending.all(channelId, limit ?? -1).map(readItem),
    itemsOfTurn: turnId => s.ofTurn.all(turnId).map(readItem),
    items: () => s.items.all().map(readItem),
    turn(id) { const row = s.turn.get(id); return row ? turn(row) : undefined; },
    putTurn(t) { s.putTurn.run(t.turnId, t.channelId, t.startedSeq, t.startedAt, t.compatibilityKey, t.state.status, JSON.stringify(t.state)); },
    liveTurn(channelId) { const row = s.live.get(channelId); return row ? turn(row) : undefined; },
    turns: () => s.turns.all().map(turn),
    latestTurn(id) {
      const row = s.latestTurn.get(id);
      return row ? turn(row) : undefined;
    },
    liveTurns: () => s.liveTurns.all().map(turn),
    policyNames: () => s.policyNames.all().map(row => String(row.name)),

    addEntry(e) { const clean = s.retrievalDirty.get()?.value === "0"; s.addEntry.run(e.seq, e.at, e.channelId, e.turnId, e.from, e.kind ?? null, e.sourceChannelId ?? null,
      e.itemId ?? null, JSON.stringify(e.message), e.externalSource ?? null);
      if (e.messageId !== undefined) s.addReplyId.run(e.seq, e.messageId);
      if (clean) {
        if (historicalCandidate(e.message, id => s.historicalRegister.run(e.turnId, id), id => !!s.historicalContains.get(e.turnId, id)))
          s.historicalCandidate.run(e.seq, e.channelId);
        const projected = retrievalMessage(e);
        if (projected) {
          s.retrievalInsert.run(e.seq, timelineIndexText(projected.text), e.channelId, timelineBytes(projected.text));
          const historical = historicalRetrievalProjection(e.message);
          if (historical !== e.message) s.historicalInsert.run(e.seq, JSON.stringify(historical));
        }
        s.retrievalClean.run();
      }
    },
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
      db.exec(SCHEMA);
      installReadIndexes(db);
      const tables = sqliteTables(db);
      try { tables.transaction(() => { tables.setMeta(meta); installContextPolicyIndex(db); refreshModelCalls(db); fill?.(tables); refreshReplyIds(db); refreshRetrieval(db, tables.entries); }); }
      finally { tables.dispose(); }
    } finally { db.close(); }
    try { linkSync(draft, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Fail("already_exists", `A session already exists at ${path}`);
      throw error;
    }
  } finally { rmSync(draft, { force: true }); rmSync(`${draft}-journal`, { force: true }); }
}

interface SavedSessionHeader { sessionId: string; config: PortableSessionConfig | undefined }

/** One SQLite file holds one session. Ownership is SQLite's exclusive file
 * lock, held from open to close: a second handle, in this or any process,
 * fails immediately, and the operating system releases it if the owner dies. */
export function createSqliteStorageAdapter(path: string, adapterOptions: { mediaRoot?: string } = {}): SessionStorageAdapter & {
  /** Inspect the saved identity and config without taking session ownership. */
  readSavedHeader(): StorageResult<SavedSessionHeader>;
} {
  const readSavedHeader = (): StorageResult<SavedSessionHeader> => {
    let db: Database | undefined;
    try {
      if (!existsSync(path)) throw new Fail("not_found", `No session exists at ${path}`);
      db = new Database(path, { readonly: true }); db.exec("PRAGMA busy_timeout=0");
      const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta WHERE key IN ('importedConfig', 'revision', 'sessionId')").all();
      const raw = rows.find(row => row.key === "importedConfig")?.value;
      const sessionId = rows.find(row => row.key === "sessionId")?.value;
      if (!sessionId?.trim()) throw new Fail("incompatible", "No saved session ID");
      return { ok: true, value: { sessionId, config: raw === undefined ? undefined : JSON.parse(raw) }, revision: Number(rows.find(row => row.key === "revision")?.value ?? 0) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return failure(new Fail("owner_conflict", "Session storage already has an owner"));
      return failure(error);
    } finally { db?.close(); }
  };
  return {
    readSavedHeader,
    readSavedConfig() {
      const result = readSavedHeader();
      return result.ok ? { ...result, value: result.value.config } : result;
    },
    importSessionFile(payload, options) {
      let releaseLease: (() => void) | undefined;
      try {
        const { archive, config } = validateSessionPayload(payload);
        if (options?.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId.trim())) throw new Fail("invalid_input", "sessionId must be a nonempty string");
        const root = adapterOptions.mediaRoot ?? `${path}.media`;
        releaseLease = acquireImportLease(path); recoverAttachmentImport(path, root);
        const meta = archiveMeta(archive, options?.sessionId);
        const publishDatabase = () => publish(path, meta, tables => { restoreArchive(tables, archive); tables.setConfig(config); });
        if (archive.attachmentState) publishAttachmentImport(path, root, archive, publishDatabase); else publishDatabase();
        return { ok: true, value: storedSession(meta), revision: meta.revision };
      } catch (error) { return failure(error); }
      finally { releaseLease?.(); }
    },
    open(options) {
      let db: Database | undefined;
      let releaseLease: (() => void) | undefined;
      try {
        const identity = options?.identity;
        if (!identity || typeof identity.sessionId !== "string" || !identity.sessionId.trim() || typeof identity.compatibilityKey !== "string"
          || (options.mode !== "create" && options.mode !== "open")) throw new Fail("invalid_input", "Open needs a mode, sessionId and compatibilityKey");
        let config; try { config = options.config === undefined ? undefined : validateManagedConfig(options.config); } catch (error) { throw new Fail("invalid_input", String(error)); }
        if (options.mode === "create") checkScriptIdentity(identity.compatibilityKey, options.requiredScriptDigest);
        if (options.mode === "open" && !existsSync(path) && !existsSync(`${path}.attachment-import`)) throw new Fail("not_found", `No session exists at ${path}`);
        releaseLease = acquireImportLease(path);
        recoverAttachmentImport(path, adapterOptions.mediaRoot ?? `${path}.media`);
        if (options.mode === "create") publish(path, { sessionId: identity.sessionId, formatVersion: 6, createdAt: new Date().toISOString(),
          compatibilityKey: identity.compatibilityKey, lifecycle: "running", revision: 0, nextTurnId: 1, nextItemNumber: 1 });
        else if (!existsSync(path)) throw new Fail("not_found", `No session exists at ${path}`);
        db = new Database(path, { readwrite: true, create: false });
        // Take the lock first, then validate, and only then let recovery write.
        db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
        db.exec("BEGIN EXCLUSIVE");
        let meta: Meta;
        const inspect = sqliteTables(db);
        try {
          try { meta = inspect.getMeta(); }
          catch { throw new Fail("incompatible", "File is not a readable harness session"); }
          if (meta.formatVersion !== 2 && meta.formatVersion !== 3 && meta.formatVersion !== 4 && meta.formatVersion !== 5 && meta.formatVersion !== 6 && meta.formatVersion !== 7 && meta.formatVersion !== 8 && meta.formatVersion !== 9 && meta.formatVersion !== 10) throw new Fail("incompatible", `Unsupported storage format: ${meta.formatVersion}`);
          const webBase = meta.formatVersion === 10 ? inspect.web.baseFormat() : undefined;
          if (meta.formatVersion === 10 && (![6, 7, 8, 9].includes(webBase ?? 0) || db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='web_dispatch'").get()?.count !== 1))
            throw new Fail("incompatible", "Format 10 is missing web dispatch evidence");
          const attachmentFormat = meta.formatVersion === 9 || webBase === 9;
          const attachmentBase = attachmentFormat ? inspect.attachments?.baseFormat() : undefined;
          if (attachmentFormat && attachmentBase !== 6 && attachmentBase !== 7 && attachmentBase !== 8)
            throw new Fail("incompatible", "Format 9 is missing its base format");
          if (attachmentFormat && db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM sqlite_schema
              WHERE type = 'table' AND name IN ('attachment_files','attachment_items','attachment_item_parts')`).get()?.count !== 3)
            throw new Fail("incompatible", "Format 9 is missing attachment storage");
          if ((attachmentFormat ? attachmentBase! : webBase ?? meta.formatVersion) >= 7 && db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM sqlite_schema
              WHERE type = 'table' AND name IN ('reminder_rows','reminder_receipts','reminder_creates','reminder_metadata')`).get()?.count !== 4)
            throw new Fail("incompatible", "Format 7 is missing reminder storage");
          if (meta.sessionId !== identity.sessionId) throw new Fail("incompatible", "File holds a different session");
          checkScriptIdentity(meta.compatibilityKey, options.requiredScriptDigest);
        } finally { inspect.dispose(); db.exec("ROLLBACK"); }
        // An old format has only the implicit legacy policy. If the candidate
        // lacks it, build an in-memory inspection view without changing the
        // owned file or running recovery. Every mutation on that view is fenced.
        const legacyNeedsPolicy = meta.formatVersion < 4 && config && !Object.hasOwn(config.policies, "__legacy_allow")
          && Number(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM items").get()?.count ?? 0) > 0;
        if (legacyNeedsPolicy) {
          const owner = db, clone = Database.deserialize(owner.serialize());
          try {
            const view = sqliteTables(clone);
            view.transaction(() => { if (meta.formatVersion === 2) upgradeFromFormat2(clone); upgradeFromFormat3(clone); addExternalSource(clone);
              view.setMeta({ ...view.getMeta(), formatVersion: 4 }); refreshReplyIds(clone); refreshModelCalls(clone); refreshRetrieval(clone, view.entries); });
            return { ok: true, value: createEngine(view, identity.compatibilityKey, () => { view.dispose(); clone.close(true); owner.close(true); }, config, true), revision: meta.revision };
          } catch (error) { clone.close(); throw error; }
        }
        const tables = sqliteTables(db), owner = db;
        const reminderEvents: NonNullable<Parameters<typeof recover>[2]> = [];
        tables.transaction(() => {
          checkUnattendedGuard(tables, config?.limits?.unattendedTurns);
          refreshReplyIds(owner);
          refreshModelCalls(owner);
          const compatible = meta.formatVersion < 4 || referencesCompatible(tables, config);
          if (meta.formatVersion >= 4 && meta.formatVersion < 6 && compatible) addExternalSource(owner);
          if (compatible)
            recover(tables, meta.formatVersion < 4 ? () => { if (meta.formatVersion === 2) upgradeFromFormat2(owner); upgradeFromFormat3(owner); addExternalSource(owner); } : undefined, reminderEvents);
          if (compatible) bindUnattendedGuard(tables, config?.limits?.unattendedTurns);
          if (tables.getMeta().formatVersion >= 6) installContextPolicyIndex(owner);
          refreshRetrieval(owner, tables.entries);
        });
        return { ok: true, value: createEngine(tables, identity.compatibilityKey, () => { tables.dispose(); owner.close(true); }, config, false, reminderEvents,
          (records, maxBytes) => readArchiveFiles(adapterOptions.mediaRoot ?? `${path}.media`, records, maxBytes)), revision: tables.getMeta().revision };
      } catch (error) {
        try { db?.close(); } catch { /* The original failure is the one to report. */ }
        const code = (error as { code?: string }).code;
        if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return failure(new Fail("owner_conflict", "Session storage already has an owner"));
        if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return failure(new Fail("incompatible", "File is not a readable harness session"));
        return failure(error);
      }
      finally { releaseLease?.(); }
    },
    importArchive(raw, options) {
      let releaseLease: (() => void) | undefined;
      try {
        const archive = validateArchive(raw);
        if (options?.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId.trim()))
          throw new Fail("invalid_input", "sessionId must be a nonempty string");
        const root = adapterOptions.mediaRoot ?? `${path}.media`;
        releaseLease = acquireImportLease(path); recoverAttachmentImport(path, root);
        const meta = archiveMeta(archive, options?.sessionId);
        const publishDatabase = () => publish(path, meta, tables => restoreArchive(tables, archive));
        if (archive.attachmentState) publishAttachmentImport(path, root, archive, publishDatabase); else publishDatabase();
        return { ok: true, value: storedSession(meta), revision: meta.revision };
      } catch (error) { return failure(error); }
      finally { releaseLease?.(); }
    },
  };
}
