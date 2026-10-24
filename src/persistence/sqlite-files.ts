import type { Database } from "bun:sqlite";
import type { SharedFile, SharedFilePage, SharedFileQuery, SharedFilesPersistence } from "../media/files.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { PersistedMediaBlock } from "./backend.ts";
interface Row { record_id: string; owner: string; sequence: number; timestamp: string; role: "assistant" | "user"; part_index: number; block: string; }
export class SqliteSharedFiles implements SharedFilesPersistence {
  constructor(private readonly database: Database) {}
  async list(query: SharedFileQuery = {}): Promise<SharedFilePage> {
    const limit = query.limit ?? 100;
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("file limit must be between 1 and 1000");
    if (!Number.isSafeInteger(offset) || offset < 0 || (query.cursor !== undefined && !/^\d+$/.test(query.cursor))) throw new Error("invalid file cursor");
    for (const size of [query.minSize, query.maxSize]) if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new Error("file size filter must be a non-negative integer");
    const where = ["json_extract(part.value, '$.type') = 'media'"];
    const values: (string | number)[] = [];
    const add = (clause: string, value: string | number | undefined) => { if (value !== undefined) { where.push(clause); values.push(value); } };
    add("record.agent_conversation_id = ?", query.agentConversationId);
    add("json_extract(part.value, '$.kind') = ?", query.kind);
    add("json_extract(part.value, '$.mimeType') = ?", query.mimeType);
    add("json_extract(part.value, '$.size') >= ?", query.minSize);
    add("json_extract(part.value, '$.size') <= ?", query.maxSize);
    const like = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
    add("json_extract(part.value, '$.name') LIKE ? ESCAPE '\\'", query.name === undefined ? undefined : like(query.name));
    add("(COALESCE(json_extract(part.value, '$.name'), '') || ' ' || json_extract(part.value, '$.kind') || ' ' || json_extract(part.value, '$.mimeType') || ' ' || json_extract(part.value, '$.size')) LIKE ? ESCAPE '\\'", query.text === undefined ? undefined : like(query.text));
    const rows = this.database.query<Row, (string | number)[]>(`
      SELECT record.record_id, record.agent_conversation_id AS owner, record.sequence, record.timestamp,
        message.role, CAST(part.key AS INTEGER) AS part_index, part.value AS block
      FROM conversation_records record JOIN conversation_messages message ON message.record_row_id = record.row_id,
        json_each(message.content_json) part
      WHERE ${where.join(" AND ")}
        AND (message.logical_message_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM conversation_records newer JOIN conversation_messages revision ON revision.record_row_id = newer.row_id
          WHERE newer.agent_conversation_id = record.agent_conversation_id
            AND revision.logical_message_id = message.logical_message_id AND newer.sequence > record.sequence
        ))
      ORDER BY record.timestamp DESC, record.record_id DESC, part_index ASC LIMIT ? OFFSET ?
    `).all(...values, limit + 1, offset);
    const files: SharedFile[] = rows.slice(0, limit).map((row) => ({
      ...JSON.parse(row.block) as PersistedMediaBlock, agentConversationId: row.owner as AgentConversationId,
      recordId: row.record_id, sequence: row.sequence, timestamp: row.timestamp, role: row.role, partIndex: row.part_index,
    }));
    return { files, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
  }
  async search(query: SharedFileQuery & { readonly text: string }): Promise<SharedFilePage> { return this.list(query); }
}
