import type { Database } from "bun:sqlite";

export const SQLITE_AGENT_SCHEMA_VERSION = 2;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  agent_session_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  agent_conversation_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  deleted_at TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS conversations_updated_idx
  ON conversations(updated_at DESC, agent_conversation_id);

CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  participant_id TEXT NOT NULL REFERENCES participants(participant_id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (agent_conversation_id, participant_id)
);

CREATE INDEX IF NOT EXISTS conversation_participants_participant_idx
  ON conversation_participants(participant_id, agent_conversation_id);

CREATE TABLE IF NOT EXISTS conversation_records (
  row_id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  agent_session_id TEXT NOT NULL,
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (agent_conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS conversation_records_kind_idx
  ON conversation_records(agent_conversation_id, kind, sequence);
CREATE INDEX IF NOT EXISTS conversation_records_time_idx
  ON conversation_records(timestamp, agent_conversation_id);

CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  agent_conversation_id TEXT PRIMARY KEY REFERENCES conversations(agent_conversation_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  covered_sequence INTEGER NOT NULL CHECK (covered_sequence >= 0),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_sessions (
  provider_session_record_id TEXT PRIMARY KEY,
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  internal_session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  activated_at TEXT NOT NULL,
  deactivated_at TEXT,
  transition_id TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS provider_sessions_conversation_idx
  ON provider_sessions(agent_conversation_id, activated_at, provider_session_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS provider_sessions_one_active_idx
  ON provider_sessions(agent_conversation_id) WHERE deactivated_at IS NULL;

CREATE TABLE IF NOT EXISTS metering_records (
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  operation_id TEXT NOT NULL,
  internal_session_id TEXT,
  adapter_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  record_json TEXT,
  PRIMARY KEY (agent_conversation_id, operation_id)
);

CREATE INDEX IF NOT EXISTS metering_records_conversation_idx
  ON metering_records(agent_conversation_id, completed_at, operation_id);
CREATE INDEX IF NOT EXISTS metering_records_internal_session_idx
  ON metering_records(internal_session_id, completed_at);

CREATE TABLE IF NOT EXISTS conversation_metering_state (
  agent_conversation_id TEXT PRIMARY KEY REFERENCES conversations(agent_conversation_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  observed_through_sequence INTEGER NOT NULL DEFAULT 0,
  processed_through_sequence INTEGER NOT NULL DEFAULT 0,
  active_snapshot_id TEXT
);

INSERT OR IGNORE INTO identity_state(
  singleton, observed_through_sequence, processed_through_sequence
) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS identity_memories (
  memory_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
  source_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  source_record_ids_json TEXT NOT NULL,
  participant_id TEXT,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS identity_memories_source_idx
  ON identity_memories(source_conversation_id, sequence);
CREATE INDEX IF NOT EXISTS identity_memories_participant_idx
  ON identity_memories(participant_id, sequence);

CREATE TABLE IF NOT EXISTS identity_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  version INTEGER NOT NULL UNIQUE CHECK (version >= 0),
  processed_through_sequence INTEGER NOT NULL CHECK (processed_through_sequence >= 0),
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_outbox (
  outbox_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  delivered_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx
  ON audit_outbox(delivered_at, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS persistence_extensions (
  extension_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_record_fts USING fts5(
  payload_json,
  content = 'conversation_records',
  content_rowid = 'row_id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS conversation_records_fts_insert
AFTER INSERT ON conversation_records BEGIN
  INSERT INTO conversation_record_fts(rowid, payload_json)
  VALUES (new.row_id, new.payload_json);
END;

CREATE TRIGGER IF NOT EXISTS conversation_records_fts_delete
AFTER DELETE ON conversation_records BEGIN
  INSERT INTO conversation_record_fts(conversation_record_fts, rowid, payload_json)
  VALUES ('delete', old.row_id, old.payload_json);
END;
`;

export function migrateSqliteAgentSchema(database: Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(BASE_SCHEMA);
    const row = database.query<{ version: number }, []>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get();
    const version = Number(row?.version ?? 0);
    if (version > SQLITE_AGENT_SCHEMA_VERSION) {
      throw new Error(
        `SQLite agent schema ${version} is newer than supported ${SQLITE_AGENT_SCHEMA_VERSION}`,
      );
    }
    if (version < 1) {
      database.query<unknown, [number, string]>(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(1, new Date().toISOString());
    }
    if (version < 2) {
      database.query<unknown, [number, string]>(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(2, new Date().toISOString());
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function installSqliteFts(database: Database): boolean {
  const row = database.query<{ enabled: number }, []>(
    "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
  ).get();
  if (Number(row?.enabled ?? 0) !== 1) return false;

  const existed = database.query<{ present: number }, []>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_record_fts'",
  ).get() !== null;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(FTS_SCHEMA);
    if (!existed) {
      database.exec("INSERT INTO conversation_record_fts(conversation_record_fts) VALUES ('rebuild')");
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
