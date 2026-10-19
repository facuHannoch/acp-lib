import type { Database } from "bun:sqlite";
import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type {
  ConversationErrorDetails,
  ConversationErrorRecoverability,
  ConversationErrorSource,
  ConversationRecord,
  ConversationRecordKind,
  NewConversationRecord,
  PersistedContent,
  PersistenceJsonValue,
} from "./backend.ts";

export interface ConversationRecordRow {
  readonly row_id: number;
  readonly record_id: string;
  readonly agent_session_id: string;
  readonly agent_conversation_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly timestamp: string;
  readonly operation_id: string | null;
  readonly metadata: string | null;
}

type SqlValue = string | number | bigint | boolean | Uint8Array | null;

export function operationIdFromRecord(record: NewConversationRecord): string | null {
  if (record.kind === "metering") return record.operationId;
  if (record.kind === "error") return record.operationId ?? null;
  if (!record.metadata) return null;
  try {
    const metadata = JSON.parse(record.metadata) as { operationId?: unknown };
    return typeof metadata?.operationId === "string" && metadata.operationId.trim()
      ? metadata.operationId
      : null;
  } catch {
    return null;
  }
}

export function insertConversationRecordDetail(
  database: Database,
  rowId: number,
  record: NewConversationRecord,
): void {
  switch (record.kind) {
    case "message": {
      const content = encodeContent(record.content);
      run(database,
        `INSERT INTO conversation_messages(
          record_row_id, role, participant_id, content_text, content_json, status, search_text,
          consumer_metadata_json, logical_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        record.role,
        record.participantId ?? null,
        content.text,
        content.json,
        record.status ?? null,
        searchableContent(record.content),
        encodeJson(record.consumerMetadata),
        record.logicalMessageId ?? null,
      );
      return;
    }
    case "tool_call": {
      const output = encodeOptionalContent(record.output);
      run(database,
        `INSERT INTO conversation_tool_call_events(
          record_row_id, tool_call_id, state, name, input_json,
          output_text, output_json, error, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        record.toolCallId,
        record.state,
        record.name ?? null,
        encodeJson(record.input),
        output.text,
        output.json,
        record.error ?? null,
        joinSearchText([
          record.name,
          searchableJson(record.input),
          record.output === undefined ? undefined : searchableContent(record.output),
          record.error,
        ]),
      );
      return;
    }
    case "permission":
      run(database,
        `INSERT INTO conversation_permission_events(
          record_row_id, permission_id, state, request_json, outcome
        ) VALUES (?, ?, ?, ?, ?)`,
        rowId,
        record.permissionId,
        record.state,
        encodeJson(record.request),
        record.outcome ?? null,
      );
      return;
    case "configuration":
      run(database,
        `INSERT INTO conversation_configuration_events(
          record_row_id, operation, config_id, value_json, status, error
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        rowId,
        record.operation,
        record.configId ?? null,
        encodeJson(record.value),
        record.status,
        record.error ?? null,
      );
      return;
    case "protocol":
      run(database,
        `INSERT INTO conversation_protocol_records(
          record_row_id, direction, method, message_json
        ) VALUES (?, ?, ?, ?)`,
        rowId,
        record.direction,
        record.method ?? null,
        encodeJson(record.message),
      );
      return;
    case "native_action":
      run(database,
        `INSERT INTO conversation_native_action_events(
          record_row_id, action, transition_id, state, input_json, output_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        record.action,
        record.transitionId ?? null,
        record.state,
        encodeJson(record.input),
        encodeJson(record.output),
        record.error ?? null,
      );
      return;
    case "agent_action":
      run(database,
        `INSERT INTO conversation_agent_action_events(
          record_row_id, action, state, input_json, output_json, error
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        rowId,
        record.action,
        record.state,
        encodeJson(record.input),
        encodeJson(record.output),
        record.error ?? null,
      );
      return;
    case "thinking": {
      const content = encodeContent(record.content);
      run(database,
        `INSERT INTO conversation_thinking_events(
          record_row_id, thinking_id, state, content_text, content_json
        ) VALUES (?, ?, ?, ?, ?)`,
        rowId,
        record.thinkingId,
        record.state,
        content.text,
        content.json,
      );
      return;
    }
    case "activity": {
      const content = encodeOptionalContent(record.content);
      run(database,
        `INSERT INTO conversation_activity_events(
          record_row_id, activity_id, activity_type, state,
          content_text, content_json, data_json, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        record.activityId,
        record.activityType,
        record.state,
        content.text,
        content.json,
        encodeJson(record.data),
        joinSearchText([
          record.activityType,
          record.content === undefined ? undefined : searchableContent(record.content),
          searchableJson(record.data),
        ]),
      );
      return;
    }
    case "metering":
      run(database,
        `INSERT INTO conversation_metering_references(
          record_row_id, operation_id, metering_record_id, status
        ) VALUES (?, ?, ?, ?)`,
        rowId,
        record.operationId,
        record.meteringRecordId,
        record.status,
      );
      return;
    case "error":
      run(database,
        `INSERT INTO conversation_error_records(
          record_row_id, source, code, recoverability, message, transition_id,
          internal_session_id, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        record.source,
        record.code,
        record.recoverability,
        record.message ?? null,
        record.transitionId ?? null,
        record.internalSessionId ?? null,
        encodeJson(record.details as PersistenceJsonValue | undefined),
      );
      return;
  }
}

export function hydrateConversationRecords(
  database: Database,
  rows: readonly ConversationRecordRow[],
): readonly ConversationRecord[] {
  if (rows.length === 0) return Object.freeze([]);
  const details = new Map<number, Record<string, unknown>>();
  for (const kind of uniqueKinds(rows)) {
    const ids = rows.filter((row) => row.kind === kind).map((row) => Number(row.row_id));
    const table = DETAIL_TABLES[kind];
    if (!table) throw new Error(`persisted conversation record has unknown kind: ${kind}`);
    const found = database.query<Record<string, unknown>, number[]>(
      `SELECT * FROM ${table} WHERE record_row_id IN (${ids.map(() => "?").join(", ")})`,
    ).all(...ids);
    for (const detail of found) details.set(Number(detail.record_row_id), detail);
  }
  return Object.freeze(rows.map((row) => {
    const detail = details.get(Number(row.row_id));
    if (!detail) {
      throw new Error(`conversation record ${row.record_id} has no ${row.kind} detail row`);
    }
    return recordFromRows(row, detail);
  }));
}

export function sameConversationRecord(
  persisted: ConversationRecord,
  candidate: NewConversationRecord,
): boolean {
  const { sequence: _sequence, ...withoutSequence } = persisted;
  return stableJson(withoutSequence) === stableJson(candidate);
}

const DETAIL_TABLES: Readonly<Record<ConversationRecordKind, string>> = Object.freeze({
  message: "conversation_messages",
  tool_call: "conversation_tool_call_events",
  permission: "conversation_permission_events",
  configuration: "conversation_configuration_events",
  protocol: "conversation_protocol_records",
  native_action: "conversation_native_action_events",
  agent_action: "conversation_agent_action_events",
  thinking: "conversation_thinking_events",
  activity: "conversation_activity_events",
  metering: "conversation_metering_references",
  error: "conversation_error_records",
});

function recordFromRows(
  row: ConversationRecordRow,
  detail: Record<string, unknown>,
): ConversationRecord {
  const envelope = {
    recordId: row.record_id,
    agentSessionId: row.agent_session_id as AgentSessionId,
    agentConversationId: row.agent_conversation_id as AgentConversationId,
    sequence: Number(row.sequence),
    kind: row.kind,
    timestamp: row.timestamp,
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  };
  switch (row.kind as ConversationRecordKind) {
    case "message":
      return Object.freeze({
        ...envelope,
        kind: "message",
        role: string(detail.role) as "assistant" | "user",
        ...(detail.participant_id !== null ? { participantId: string(detail.participant_id) } : {}),
        ...(detail.consumer_metadata_json !== null
          ? { consumerMetadata: decodeJson(detail.consumer_metadata_json) }
          : {}),
        ...(detail.logical_message_id != null
          ? { logicalMessageId: string(detail.logical_message_id) }
          : {}),
        content: decodeContent(detail.content_text, detail.content_json),
        ...(detail.status !== null ? { status: string(detail.status) as "in_progress" | "completed" | "cancelled" | "failed" } : {}),
      });
    case "tool_call":
      return Object.freeze({
        ...envelope,
        kind: "tool_call",
        toolCallId: string(detail.tool_call_id),
        state: string(detail.state) as "announced" | "input" | "completed" | "failed",
        ...(detail.name !== null ? { name: string(detail.name) } : {}),
        ...(detail.input_json !== null ? { input: decodeJson(detail.input_json) } : {}),
        ...(hasContent(detail.output_text, detail.output_json)
          ? { output: decodeContent(detail.output_text, detail.output_json) }
          : {}),
        ...(detail.error !== null ? { error: string(detail.error) } : {}),
      });
    case "permission":
      return Object.freeze({
        ...envelope,
        kind: "permission",
        permissionId: string(detail.permission_id),
        state: string(detail.state) as "requested" | "resolved",
        ...(detail.request_json !== null ? { request: decodeJson(detail.request_json) } : {}),
        ...(detail.outcome !== null ? { outcome: string(detail.outcome) as "approved" | "denied" | "cancelled" } : {}),
      });
    case "configuration":
      return Object.freeze({
        ...envelope,
        kind: "configuration",
        operation: string(detail.operation) as "set" | "restore" | "accept_effective" | "replace",
        ...(detail.config_id !== null ? { configId: string(detail.config_id) } : {}),
        ...(detail.value_json !== null ? { value: decodeJson(detail.value_json) } : {}),
        status: string(detail.status) as "started" | "completed" | "failed",
        ...(detail.error !== null ? { error: string(detail.error) } : {}),
      });
    case "protocol":
      return Object.freeze({
        ...envelope,
        kind: "protocol",
        direction: string(detail.direction) as "in" | "out" | "error",
        ...(detail.method !== null ? { method: string(detail.method) } : {}),
        ...(detail.message_json !== null ? { message: decodeJson(detail.message_json) } : {}),
      });
    case "native_action":
      return Object.freeze({
        ...envelope,
        kind: "native_action",
        action: string(detail.action),
        ...(detail.transition_id !== null ? { transitionId: string(detail.transition_id) } : {}),
        state: string(detail.state) as "started" | "checkpoint" | "completed" | "failed",
        ...(detail.input_json !== null ? { input: decodeJson(detail.input_json) } : {}),
        ...(detail.output_json !== null ? { output: decodeJson(detail.output_json) } : {}),
        ...(detail.error !== null ? { error: string(detail.error) } : {}),
      });
    case "agent_action":
      return Object.freeze({
        ...envelope,
        kind: "agent_action",
        action: string(detail.action),
        state: string(detail.state) as "requested" | "completed" | "failed",
        ...(detail.input_json !== null ? { input: decodeJson(detail.input_json) } : {}),
        ...(detail.output_json !== null ? { output: decodeJson(detail.output_json) } : {}),
        ...(detail.error !== null ? { error: string(detail.error) } : {}),
      });
    case "thinking":
      return Object.freeze({
        ...envelope,
        kind: "thinking",
        thinkingId: string(detail.thinking_id),
        state: string(detail.state) as "in_progress" | "completed" | "failed",
        content: decodeContent(detail.content_text, detail.content_json),
      });
    case "activity":
      return Object.freeze({
        ...envelope,
        kind: "activity",
        activityId: string(detail.activity_id),
        activityType: string(detail.activity_type),
        state: string(detail.state) as "in_progress" | "completed" | "failed",
        ...(hasContent(detail.content_text, detail.content_json)
          ? { content: decodeContent(detail.content_text, detail.content_json) }
          : {}),
        ...(detail.data_json !== null ? { data: decodeJson(detail.data_json) } : {}),
      });
    case "metering":
      return Object.freeze({
        ...envelope,
        kind: "metering",
        operationId: string(detail.operation_id),
        meteringRecordId: string(detail.metering_record_id),
        status: string(detail.status) as "available" | "partial" | "unavailable",
      });
    case "error":
      return Object.freeze({
        ...envelope,
        kind: "error",
        source: string(detail.source) as ConversationErrorSource,
        code: string(detail.code),
        recoverability: string(detail.recoverability) as ConversationErrorRecoverability,
        ...(detail.message !== null ? { message: string(detail.message) } : {}),
        ...(row.operation_id !== null ? { operationId: string(row.operation_id) } : {}),
        ...(detail.transition_id !== null ? { transitionId: string(detail.transition_id) } : {}),
        ...(detail.internal_session_id !== null
          ? { internalSessionId: string(detail.internal_session_id) }
          : {}),
        ...(detail.details_json !== null
          ? { details: decodeJson(detail.details_json) as ConversationErrorDetails }
          : {}),
      });
  }
}

function encodeContent(content: PersistedContent): { text: string | null; json: string | null } {
  return typeof content === "string"
    ? { text: content, json: null }
    : { text: null, json: JSON.stringify(content) };
}

function encodeOptionalContent(content: PersistedContent | undefined) {
  return content === undefined ? { text: null, json: null } : encodeContent(content);
}

function decodeContent(text: unknown, json: unknown): PersistedContent {
  if (text !== null) return string(text);
  if (json !== null) return decodeJson(json) as PersistedContent;
  throw new Error("persisted content has neither text nor structured data");
}

function hasContent(text: unknown, json: unknown): boolean {
  return text !== null || json !== null;
}

function encodeJson(value: PersistenceJsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeJson(value: unknown): PersistenceJsonValue {
  return JSON.parse(string(value)) as PersistenceJsonValue;
}

function searchableContent(content: PersistedContent): string {
  return typeof content === "string" ? content : searchableJson(content);
}

function searchableJson(value: PersistenceJsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return joinSearchText(value.map((item) => searchableJson(item)));
  return joinSearchText(Object.values(value).map((item) => searchableJson(item)));
}

function joinSearchText(values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value?.trim())).join("\n");
}

function uniqueKinds(rows: readonly ConversationRecordRow[]): ConversationRecordKind[] {
  return [...new Set(rows.map((row) => row.kind as ConversationRecordKind))];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("persisted conversation detail is malformed");
  return value;
}

function run(database: Database, sql: string, ...values: SqlValue[]): void {
  database.query(sql).run(...values);
}
