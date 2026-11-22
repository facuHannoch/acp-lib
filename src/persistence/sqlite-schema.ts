import type { Database } from "bun:sqlite";
import { contentText } from "../media/content.ts";
import type { PersistedContent } from "./backend.ts";

export const SQLITE_AGENT_SCHEMA_VERSION = 17;

const CHANNEL_INTENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_channel_intent_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS native_channel_intents (
  channel TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  desire_json TEXT NOT NULL CHECK (json_valid(desire_json) AND json_type(desire_json) = 'object')
);
`;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS out_of_band_delivery (
  owner TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  provider_context TEXT NOT NULL,
  through_sequence INTEGER NOT NULL,
  PRIMARY KEY(owner, provider_context)
);

CREATE TABLE IF NOT EXISTS conversation_media (
  ref TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'file')),
  mime_type TEXT NOT NULL,
  name TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_media_owner_idx ON conversation_media(owner);

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
  last_human_message_at TEXT,
  deleted_at TEXT,
  metadata TEXT,
  adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
  adopt_provider_session_id TEXT
);

CREATE INDEX IF NOT EXISTS conversations_updated_idx
  ON conversations(updated_at DESC, agent_conversation_id);

CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'user', 'external')),
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
  kind TEXT NOT NULL CHECK (kind IN (
    'message',
    'tool_call',
    'permission',
    'configuration',
    'protocol',
    'native_action',
    'agent_action',
    'thinking',
    'activity',
    'metering',
    'error',
    'cancellation'
  )),
  timestamp TEXT NOT NULL,
  operation_id TEXT,
  metadata TEXT,
  UNIQUE (agent_conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS conversation_records_kind_idx
  ON conversation_records(agent_conversation_id, kind, sequence);
CREATE INDEX IF NOT EXISTS conversation_records_time_idx
  ON conversation_records(timestamp, agent_conversation_id);
CREATE INDEX IF NOT EXISTS conversation_records_operation_idx
  ON conversation_records(agent_conversation_id, operation_id, sequence)
  WHERE operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_messages (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
  participant_id TEXT REFERENCES participants(participant_id),
  content_text TEXT,
  content_json TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('in_progress', 'completed', 'cancelled', 'failed')),
  search_text TEXT NOT NULL,
  consumer_metadata_json TEXT CHECK (consumer_metadata_json IS NULL OR json_valid(consumer_metadata_json)),
  logical_message_id TEXT,
  CHECK ((content_text IS NULL) <> (content_json IS NULL)),
  CHECK (content_json IS NULL OR json_valid(content_json))
);

CREATE INDEX IF NOT EXISTS conversation_messages_participant_idx
  ON conversation_messages(participant_id, record_row_id)
  WHERE participant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_tool_call_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('announced', 'input', 'completed', 'failed')),
  name TEXT,
  input_json TEXT,
  output_text TEXT,
  output_json TEXT,
  error TEXT,
  search_text TEXT NOT NULL,
  CHECK (input_json IS NULL OR json_valid(input_json)),
  CHECK (output_json IS NULL OR json_valid(output_json)),
  CHECK (NOT (output_text IS NOT NULL AND output_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS conversation_tool_calls_identity_idx
  ON conversation_tool_call_events(tool_call_id, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_permission_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'resolved')),
  request_json TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('approved', 'denied', 'cancelled')),
  CHECK (request_json IS NULL OR json_valid(request_json))
);

CREATE INDEX IF NOT EXISTS conversation_permissions_identity_idx
  ON conversation_permission_events(permission_id, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_configuration_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('set', 'restore', 'accept_effective', 'replace')),
  config_id TEXT,
  value_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  error TEXT,
  CHECK (value_json IS NULL OR json_valid(value_json))
);

CREATE TABLE IF NOT EXISTS conversation_protocol_records (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'error')),
  method TEXT,
  message_json TEXT,
  CHECK (message_json IS NULL OR json_valid(message_json))
);

CREATE TABLE IF NOT EXISTS conversation_native_action_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  transition_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('started', 'checkpoint', 'completed', 'failed')),
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  CHECK (input_json IS NULL OR json_valid(input_json)),
  CHECK (output_json IS NULL OR json_valid(output_json))
);

CREATE TABLE IF NOT EXISTS conversation_agent_action_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'completed', 'failed')),
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  CHECK (input_json IS NULL OR json_valid(input_json)),
  CHECK (output_json IS NULL OR json_valid(output_json))
);

CREATE TABLE IF NOT EXISTS conversation_thinking_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  thinking_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'failed')),
  content_text TEXT,
  content_json TEXT,
  CHECK ((content_text IS NULL) <> (content_json IS NULL)),
  CHECK (content_json IS NULL OR json_valid(content_json))
);

CREATE INDEX IF NOT EXISTS conversation_thinking_identity_idx
  ON conversation_thinking_events(thinking_id, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_activity_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'failed')),
  content_text TEXT,
  content_json TEXT,
  data_json TEXT,
  search_text TEXT NOT NULL,
  CHECK (NOT (content_text IS NOT NULL AND content_json IS NOT NULL)),
  CHECK (content_json IS NULL OR json_valid(content_json)),
  CHECK (data_json IS NULL OR json_valid(data_json))
);

CREATE INDEX IF NOT EXISTS conversation_activities_identity_idx
  ON conversation_activity_events(activity_id, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_metering_references (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  metering_record_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'partial', 'unavailable'))
);

CREATE INDEX IF NOT EXISTS conversation_metering_operation_idx
  ON conversation_metering_references(operation_id, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_error_records (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN (
    'provider_session', 'transport', 'operation', 'recovery'
  )),
  code TEXT NOT NULL CHECK (length(trim(code)) > 0),
  recoverability TEXT NOT NULL CHECK (recoverability IN (
    'retryable', 'recoverable', 'terminal', 'unknown'
  )),
  message TEXT,
  transition_id TEXT,
  internal_session_id TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json))
);

CREATE INDEX IF NOT EXISTS conversation_error_source_code_idx
  ON conversation_error_records(source, code, record_row_id);

CREATE TABLE IF NOT EXISTS conversation_cancellation_events (
  record_row_id INTEGER PRIMARY KEY REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  cancellation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'resolved')),
  reason TEXT NOT NULL CHECK (reason IN ('interrupt', 'steer', 'stalled', 'stop', 'abort')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('acknowledged', 'forced', 'too_late', 'failed'))
);

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
CREATE INDEX IF NOT EXISTS provider_sessions_internal_idx
  ON provider_sessions(internal_session_id);
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

CREATE TABLE IF NOT EXISTS agent_metering_records (
  agent_session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  internal_session_id TEXT,
  adapter_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  record_json TEXT,
  PRIMARY KEY (agent_session_id, operation_id)
);

CREATE INDEX IF NOT EXISTS agent_metering_records_scope_idx
  ON agent_metering_records(agent_session_id, completed_at, operation_id);

CREATE TABLE IF NOT EXISTS agent_metering_state (
  agent_session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS internal_inference_chains (
  root_internal_inference_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  agent_conversation_id TEXT REFERENCES conversations(agent_conversation_id),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
  active_internal_inference_id TEXT,
  requested_through_sequence INTEGER CHECK (
    requested_through_sequence IS NULL OR requested_through_sequence >= 0
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);

DROP INDEX IF EXISTS internal_inference_one_active_chain_idx;
CREATE UNIQUE INDEX IF NOT EXISTS internal_inference_one_active_checkpoint_chain_idx
  ON internal_inference_chains(
    agent_session_id,
    COALESCE(agent_conversation_id, ''),
    purpose
  ) WHERE status = 'active' AND purpose = 'conversation_checkpoint';

CREATE TABLE IF NOT EXISTS internal_inferences (
  internal_inference_id TEXT PRIMARY KEY,
  root_internal_inference_id TEXT NOT NULL REFERENCES internal_inference_chains(root_internal_inference_id),
  retry_of_internal_inference_id TEXT REFERENCES internal_inferences(internal_inference_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  agent_session_id TEXT NOT NULL,
  agent_conversation_id TEXT REFERENCES conversations(agent_conversation_id),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  adapter_id TEXT NOT NULL,
  execution_profile_id TEXT,
  input_json TEXT NOT NULL,
  model TEXT,
  internal_session_id TEXT,
  source_checkpoint_id TEXT,
  source_from_sequence INTEGER CHECK (source_from_sequence IS NULL OR source_from_sequence >= 0),
  source_through_sequence INTEGER CHECK (source_through_sequence IS NULL OR source_through_sequence >= 0),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  next_attempt_at TEXT,
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  result_json TEXT,
  error TEXT,
  failure_code TEXT,
  metering_operation_id TEXT,
  metadata TEXT,
  UNIQUE (root_internal_inference_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS internal_inferences_claim_idx
  ON internal_inferences(status, next_attempt_at, requested_at, internal_inference_id);
CREATE INDEX IF NOT EXISTS internal_inferences_chain_idx
  ON internal_inferences(root_internal_inference_id, attempt_number);
CREATE INDEX IF NOT EXISTS internal_inferences_lease_idx
  ON internal_inferences(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS conversation_recovery_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  covered_sequence INTEGER NOT NULL CHECK (covered_sequence >= 1),
  previous_checkpoint_id TEXT REFERENCES conversation_recovery_checkpoints(checkpoint_id),
  generator_internal_inference_id TEXT UNIQUE REFERENCES internal_inferences(internal_inference_id),
  source TEXT NOT NULL DEFAULT 'internal_inference'
    CHECK (source IN ('internal_inference', 'adoption_recap', 'adoption_baseline')),
  summary TEXT NOT NULL,
  responses_counted_after_sequence INTEGER CHECK (responses_counted_after_sequence IS NULL OR responses_counted_after_sequence >= 0),
  created_at TEXT NOT NULL,
  metadata TEXT,
  UNIQUE (agent_conversation_id, revision),
  UNIQUE (agent_conversation_id, covered_sequence),
  CHECK (
    (source = 'internal_inference' AND generator_internal_inference_id IS NOT NULL AND length(summary) > 0)
    OR (source = 'adoption_recap' AND generator_internal_inference_id IS NULL AND length(summary) > 0)
    OR (source = 'adoption_baseline' AND generator_internal_inference_id IS NULL AND summary = '')
  )
);

CREATE INDEX IF NOT EXISTS recovery_checkpoints_latest_idx
  ON conversation_recovery_checkpoints(agent_conversation_id, revision DESC);

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

CREATE TABLE IF NOT EXISTS identity_delivery_cursors (
  target_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  target_provider_context_id TEXT NOT NULL CHECK (length(target_provider_context_id) > 0),
  source_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  delivered_through_sequence INTEGER NOT NULL CHECK (delivered_through_sequence > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_conversation_id, target_provider_context_id, source_conversation_id),
  CHECK (target_conversation_id <> source_conversation_id)
);

CREATE INDEX IF NOT EXISTS identity_delivery_cursors_source_idx
  ON identity_delivery_cursors(source_conversation_id);

CREATE TABLE IF NOT EXISTS agent_audit_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  audit_log_id TEXT NOT NULL UNIQUE,
  last_allocated_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_allocated_sequence >= 0),
  last_delivered_sequence INTEGER NOT NULL DEFAULT 0 CHECK (
    last_delivered_sequence >= 0 AND last_delivered_sequence <= last_allocated_sequence
  ),
  capture_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_outbox (
  outbox_id TEXT PRIMARY KEY,
  audit_sequence INTEGER NOT NULL UNIQUE CHECK (audit_sequence > 0),
  source_observation_id TEXT NOT NULL UNIQUE,
  source_record_id TEXT,
  operation_id TEXT,
  agent_conversation_id TEXT REFERENCES conversations(agent_conversation_id),
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  capture_level TEXT NOT NULL,
  capture_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx
  ON audit_outbox(audit_sequence);

CREATE TABLE IF NOT EXISTS persistence_extensions (
  extension_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
  search_text,
  content = 'conversation_messages',
  content_rowid = 'record_row_id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_insert
AFTER INSERT ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(rowid, search_text)
  VALUES (new.record_row_id, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_delete
AFTER DELETE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, search_text)
  VALUES ('delete', old.record_row_id, old.search_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_tool_calls_fts USING fts5(
  search_text,
  content = 'conversation_tool_call_events',
  content_rowid = 'record_row_id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS conversation_tool_calls_fts_insert
AFTER INSERT ON conversation_tool_call_events BEGIN
  INSERT INTO conversation_tool_calls_fts(rowid, search_text)
  VALUES (new.record_row_id, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS conversation_tool_calls_fts_delete
AFTER DELETE ON conversation_tool_call_events BEGIN
  INSERT INTO conversation_tool_calls_fts(conversation_tool_calls_fts, rowid, search_text)
  VALUES ('delete', old.record_row_id, old.search_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_activities_fts USING fts5(
  search_text,
  content = 'conversation_activity_events',
  content_rowid = 'record_row_id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS conversation_activities_fts_insert
AFTER INSERT ON conversation_activity_events BEGIN
  INSERT INTO conversation_activities_fts(rowid, search_text)
  VALUES (new.record_row_id, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS conversation_activities_fts_delete
AFTER DELETE ON conversation_activity_events BEGIN
  INSERT INTO conversation_activities_fts(conversation_activities_fts, rowid, search_text)
  VALUES ('delete', old.record_row_id, old.search_text);
END;
`;

/**
 * Version 15: records written before every write site passed its operation id recover it where it
 * is still known. Runtime, permission and configuration record ids begin with it; native actions
 * keep it as their transition id. Anything else stays without one.
 */
function backfillRecordOperationIds(database: Database): void {
  for (const [separator, kinds] of [
    [":runtime:", "'tool_call', 'thinking', 'activity'"],
    [":permission:", "'permission'"],
    [":configuration:", "'configuration'"],
  ] as const) {
    database.query<unknown, [string, string]>(
      `UPDATE conversation_records SET operation_id = substr(record_id, 1, instr(record_id, ?) - 1)
       WHERE operation_id IS NULL AND kind IN (${kinds}) AND instr(record_id, ?) > 1`,
    ).run(separator, separator);
  }
  database.exec(`UPDATE conversation_records SET operation_id = (
      SELECT n.transition_id FROM conversation_native_action_events n WHERE n.record_row_id = conversation_records.row_id
    )
    WHERE operation_id IS NULL AND kind = 'native_action' AND EXISTS (
      SELECT 1 FROM conversation_native_action_events n
      WHERE n.record_row_id = conversation_records.row_id AND n.transition_id IS NOT NULL
    )`);
}

export function migrateSqliteAgentSchema(database: Database): void {
  const hasMigrations = database.query<{ present: number }, []>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() !== null;
  const existing = hasMigrations
    ? Number(database.query<{ version: number }, []>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get()?.version ?? 0)
    : 0;
  if (existing !== 0 && ![8, 9, 10, 11, 12, 13, 14, 15, 16, SQLITE_AGENT_SCHEMA_VERSION].includes(existing)) {
    throw new Error(
      `SQLite agent schema ${existing} is incompatible with ${SQLITE_AGENT_SCHEMA_VERSION}; recreate the database`,
    );
  }
  // Admitting a new record kind means rebuilding conversation_records: its kind CHECK is a
  // closed list SQLite cannot alter in place. Foreign keys must be off for that drop, or
  // the implicit delete would cascade into every detail table.
  const rebuildRecords = existing > 0 && existing < 15;
  if (rebuildRecords) database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(BASE_SCHEMA);
      const row = database.query<{ version: number }, []>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get();
      const version = Number(row?.version ?? 0);
      if (version > 0 && version < 10) {
        database.exec(`ALTER TABLE conversation_messages ADD COLUMN consumer_metadata_json TEXT
          CHECK (consumer_metadata_json IS NULL OR json_valid(consumer_metadata_json))`);
        database.exec("ALTER TABLE conversations ADD COLUMN last_human_message_at TEXT");
        database.exec(`UPDATE conversations SET last_human_message_at = (
          SELECT r.timestamp FROM conversation_records r
          JOIN conversation_messages m ON m.record_row_id = r.row_id
          JOIN participants p ON p.participant_id = m.participant_id
          WHERE r.agent_conversation_id = conversations.agent_conversation_id
            AND r.kind = 'message' AND m.role = 'user' AND p.kind = 'user'
          ORDER BY r.sequence DESC LIMIT 1
        )`);
      }
      if (version > 0 && version < 11) {
        database.exec("ALTER TABLE conversation_messages ADD COLUMN logical_message_id TEXT");
      }
      database.exec(`CREATE INDEX IF NOT EXISTS conversation_messages_logical_idx
        ON conversation_messages(logical_message_id, record_row_id)
        WHERE logical_message_id IS NOT NULL`);
      if (version > 0 && version < 15) {
        // Version 12 admitted `error`, version 15 `cancellation`: one rebuild admits every kind.
        rebuildConversationRecordsForKinds(database);
        const violations = database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error("SQLite schema migration to version 15 left foreign key violations");
        }
      }
      if (version > 0 && version < 13) {
        // Adoption: whether the conversation was created from an existing provider session, and which
        // one it asked for (kept so a failed adoption can be retried).
        database.exec("ALTER TABLE conversations ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1))");
        database.exec("ALTER TABLE conversations ADD COLUMN adopt_provider_session_id TEXT");
      }
      if (version > 0 && version < 14) {
        rebuildRecoveryCheckpointsForAdoption(database);
        const violations = database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error("SQLite schema migration to version 14 left foreign key violations");
        }
      }
      if (version > 0 && version < 15) backfillRecordOperationIds(database);
      if (version < 16) {
        // Old structured search rows could contain inline base64 and media refs. Updating the
        // source search text requires rebuilding an existing append-only FTS index as well.
        const structured = database.query<{ record_row_id: number; content_json: string }, []>(
          "SELECT record_row_id, content_json FROM conversation_messages WHERE content_json IS NOT NULL",
        ).iterate();
        const update = database.query("UPDATE conversation_messages SET search_text = ? WHERE record_row_id = ?");
        for (const row of structured) {
          update.run(contentText(JSON.parse(row.content_json) as PersistedContent), row.record_row_id);
        }
        const fts = database.query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_messages_fts'",
        ).get();
        if (fts) {
          database.exec("INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES ('rebuild')");
        }
      }
      if (version < 17) database.exec(CHANNEL_INTENT_SCHEMA);
      if (version < SQLITE_AGENT_SCHEMA_VERSION) {
        database.query<unknown, [number, string]>(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        ).run(SQLITE_AGENT_SCHEMA_VERSION, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (rebuildRecords) database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Rebuild `conversation_recovery_checkpoints` so a checkpoint may have no generator and an empty summary
 * (adoption checkpoints), with a `source` and the adoption response-count base. SQLite cannot relax a
 * NOT NULL or a CHECK in place. Foreign keys are off (see the caller). The old table's index goes with it and
 * is recreated on the new one.
 */
function rebuildRecoveryCheckpointsForAdoption(database: Database): void {
  database.exec("ALTER TABLE conversation_recovery_checkpoints RENAME TO conversation_recovery_checkpoints_v13");
  database.exec("DROP INDEX IF EXISTS recovery_checkpoints_latest_idx");
  database.exec(`
CREATE TABLE conversation_recovery_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  covered_sequence INTEGER NOT NULL CHECK (covered_sequence >= 1),
  previous_checkpoint_id TEXT REFERENCES conversation_recovery_checkpoints(checkpoint_id),
  generator_internal_inference_id TEXT UNIQUE REFERENCES internal_inferences(internal_inference_id),
  source TEXT NOT NULL DEFAULT 'internal_inference'
    CHECK (source IN ('internal_inference', 'adoption_recap', 'adoption_baseline')),
  summary TEXT NOT NULL,
  responses_counted_after_sequence INTEGER CHECK (responses_counted_after_sequence IS NULL OR responses_counted_after_sequence >= 0),
  created_at TEXT NOT NULL,
  metadata TEXT,
  UNIQUE (agent_conversation_id, revision),
  UNIQUE (agent_conversation_id, covered_sequence),
  CHECK (
    (source = 'internal_inference' AND generator_internal_inference_id IS NOT NULL AND length(summary) > 0)
    OR (source = 'adoption_recap' AND generator_internal_inference_id IS NULL AND length(summary) > 0)
    OR (source = 'adoption_baseline' AND generator_internal_inference_id IS NULL AND summary = '')
  )
)`);
  database.exec(`INSERT INTO conversation_recovery_checkpoints(
      checkpoint_id, agent_conversation_id, revision, covered_sequence, previous_checkpoint_id,
      generator_internal_inference_id, source, summary, created_at, metadata
    ) SELECT checkpoint_id, agent_conversation_id, revision, covered_sequence, previous_checkpoint_id,
      generator_internal_inference_id, 'internal_inference', summary, created_at, metadata
    FROM conversation_recovery_checkpoints_v13`);
  database.exec("DROP TABLE conversation_recovery_checkpoints_v13");
  database.exec(`CREATE INDEX IF NOT EXISTS recovery_checkpoints_latest_idx
    ON conversation_recovery_checkpoints(agent_conversation_id, revision DESC)`);
}

/**
 * Rebuild `conversation_records` so its `kind` CHECK admits `error`.
 *
 * Row ids are copied verbatim, so every detail table's `record_row_id` reference survives
 * the swap. The caller runs this with foreign keys disabled and verifies with
 * `PRAGMA foreign_key_check` afterward.
 */
/** Recreate conversation_records with the current kind CHECK, keeping every row and its row id. */
function rebuildConversationRecordsForKinds(database: Database): void {
  database.exec(`CREATE TABLE conversation_records_v12 (
    row_id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE,
    agent_session_id TEXT NOT NULL,
    agent_conversation_id TEXT NOT NULL REFERENCES conversations(agent_conversation_id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    kind TEXT NOT NULL CHECK (kind IN (
      'message',
      'tool_call',
      'permission',
      'configuration',
      'protocol',
      'native_action',
      'agent_action',
      'thinking',
      'activity',
      'metering',
      'error',
      'cancellation'
    )),
    timestamp TEXT NOT NULL,
    operation_id TEXT,
    metadata TEXT,
    UNIQUE (agent_conversation_id, sequence)
  )`);
  database.exec(`INSERT INTO conversation_records_v12(
    row_id, record_id, agent_session_id, agent_conversation_id, sequence, kind, timestamp, operation_id, metadata
  ) SELECT row_id, record_id, agent_session_id, agent_conversation_id, sequence, kind, timestamp, operation_id, metadata
    FROM conversation_records`);
  database.exec("DROP TABLE conversation_records");
  database.exec("ALTER TABLE conversation_records_v12 RENAME TO conversation_records");
  database.exec(`CREATE INDEX IF NOT EXISTS conversation_records_kind_idx
    ON conversation_records(agent_conversation_id, kind, sequence)`);
  database.exec(`CREATE INDEX IF NOT EXISTS conversation_records_time_idx
    ON conversation_records(timestamp, agent_conversation_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS conversation_records_operation_idx
    ON conversation_records(agent_conversation_id, operation_id, sequence)
    WHERE operation_id IS NOT NULL`);
}

export function installSqliteFts(database: Database): boolean {
  const row = database.query<{ enabled: number }, []>(
    "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
  ).get();
  if (Number(row?.enabled ?? 0) !== 1) return false;

  const existed = ["conversation_messages_fts", "conversation_tool_calls_fts", "conversation_activities_fts"]
    .every((name) => database.query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name) !== null);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(FTS_SCHEMA);
    if (!existed) {
      database.exec("INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES ('rebuild')");
      database.exec("INSERT INTO conversation_tool_calls_fts(conversation_tool_calls_fts) VALUES ('rebuild')");
      database.exec("INSERT INTO conversation_activities_fts(conversation_activities_fts) VALUES ('rebuild')");
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
