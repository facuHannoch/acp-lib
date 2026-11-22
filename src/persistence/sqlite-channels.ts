import type { Database } from "bun:sqlite";
import type { ChannelDesire, ChannelPersistence, PendingChange } from "./channels.ts";

type Runner = <T>(work: () => T) => Promise<T>;
type Row = { channel: string; version: number; desire_json: string };

function toChange(row: Row): PendingChange {
  return { channel: row.channel, version: row.version, desire: JSON.parse(row.desire_json) as ChannelDesire };
}

export class SqliteChannelPersistence implements ChannelPersistence {
  constructor(
    private readonly database: Database,
    private readonly runWrite: Runner,
    private readonly runRead: Runner,
  ) {}

  private read(channel: string): Row | null {
    return this.database.query<Row, [string]>(
      "SELECT channel, version, desire_json FROM native_channel_intents WHERE channel = ?",
    ).get(channel);
  }

  desire(channel: string, desire: ChannelDesire): Promise<PendingChange> {
    // Capture the edit before entering the queue. Undefined means no edit; null clears a field.
    const edit: ChannelDesire = {
      ...(desire.displayName !== undefined ? { displayName: desire.displayName } : {}),
      ...(desire.policy !== undefined ? { policy: desire.policy } : {}),
      ...(desire.lifecycle !== undefined ? { lifecycle: desire.lifecycle } : {}),
    };
    return this.runWrite(() => {
      const previous = this.read(channel);
      const merged = { ...(previous && toChange(previous).desire), ...edit };
      const { version } = this.database.query<{ version: number }, []>(`
        INSERT INTO native_channel_intent_clock(singleton, version) VALUES (1, 1)
        ON CONFLICT(singleton) DO UPDATE SET version = version + 1
        RETURNING version
      `).get()!;
      this.database.query(`
        INSERT INTO native_channel_intents(channel, version, desire_json) VALUES (?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET version = excluded.version, desire_json = excluded.desire_json
      `).run(channel, version, JSON.stringify(merged));
      return { channel, version, desire: merged };
    });
  }

  pendingChange(channel: string): Promise<PendingChange | undefined> {
    return this.runRead(() => {
      const row = this.read(channel);
      return row ? toChange(row) : undefined;
    });
  }

  pendingChanges(): Promise<PendingChange[]> {
    return this.runRead(() => this.database.query<Row, []>(
      "SELECT channel, version, desire_json FROM native_channel_intents ORDER BY channel",
    ).all().map(toChange));
  }

  confirmChange(channel: string, version: number): Promise<boolean> {
    return this.runWrite(() => this.database.query(
      "DELETE FROM native_channel_intents WHERE channel = ? AND version = ?",
    ).run(channel, version).changes === 1);
  }
}
