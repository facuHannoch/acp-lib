import type { Database } from "bun:sqlite";
import type { WorkerPersistence, WorkerRow } from "./workers.ts";

type Runner = <T>(work: () => T) => Promise<T>;
type Row = {
  handle: string;
  conversation_id: WorkerRow["conversationId"];
  opened_by: WorkerRow["openedBy"];
  about: string | null;
  last_conversation: NonNullable<WorkerRow["lastConversation"]> | null;
  created_at: string;
  dropped_at: string | null;
};

function project(row: Row): WorkerRow {
  return {
    handle: row.handle, conversationId: row.conversation_id, openedBy: row.opened_by,
    createdAt: row.created_at,
    ...(row.about === null ? {} : { about: row.about }),
    ...(row.last_conversation === null ? {} : { lastConversation: row.last_conversation }),
    ...(row.dropped_at === null ? {} : { droppedAt: row.dropped_at }),
  };
}

export class SqliteWorkers implements WorkerPersistence {
  constructor(private readonly database: Database, private readonly write: Runner, private readonly read: Runner) {}

  create(row: WorkerRow): Promise<void> {
    return this.write(() => {
      this.database.query(`INSERT INTO workers
        (handle, conversation_id, opened_by, about, last_conversation, created_at, dropped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(row.handle, row.conversationId, row.openedBy, row.about ?? null, row.lastConversation ?? null,
          row.createdAt, row.droppedAt ?? null);
    });
  }

  get(handle: string): Promise<WorkerRow | undefined> {
    return this.read(() => {
      const row = this.database.query<Row, [string]>("SELECT * FROM workers WHERE handle = ?").get(handle);
      return row ? project(row) : undefined;
    });
  }

  list(): Promise<readonly WorkerRow[]> {
    return this.read(() => this.database.query<Row, []>("SELECT * FROM workers ORDER BY created_at, handle").all().map(project));
  }

  update(handle: string, change: Pick<WorkerRow, "about" | "lastConversation">): Promise<boolean> {
    return this.write(() => this.database.query(`UPDATE workers
      SET about = COALESCE(?, about), last_conversation = COALESCE(?, last_conversation)
      WHERE handle = ? AND dropped_at IS NULL`).run(change.about ?? null, change.lastConversation ?? null, handle).changes === 1);
  }

  drop(handle: string, droppedAt: string): Promise<boolean> {
    return this.write(() => this.database.query("UPDATE workers SET dropped_at = ? WHERE handle = ? AND dropped_at IS NULL")
      .run(droppedAt, handle).changes === 1);
  }
}
