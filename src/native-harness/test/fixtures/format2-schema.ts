/** The SQLite schema written by the persistence revision (storage format 2, commit 3a236ac),
 * kept verbatim so tests can build real format 2 databases (decision 0014). */
export const FORMAT2_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE channels (channel_id TEXT PRIMARY KEY, position INTEGER NOT NULL);
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
  milestone TEXT NOT NULL CHECK (milestone IN ('received','taken','delivered','seen')),
  turn_id INTEGER REFERENCES turns(turn_id), entry_seq INTEGER REFERENCES entries(seq),
  CHECK ((milestone = 'received') = (turn_id IS NULL)));
CREATE INDEX items_pending ON items(channel_id, accepted_seq) WHERE milestone = 'received';
CREATE INDEX items_by_turn ON items(turn_id, entry_seq);
`;
