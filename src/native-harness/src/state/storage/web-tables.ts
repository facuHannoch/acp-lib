import type { Database } from "bun:sqlite";
import type { StoredWebDispatch } from "../../contracts/web.ts";

/** Separate canonical evidence survives result loss and backend reconfiguration. */
export interface WebTables {
  baseFormat(): number | undefined;
  advanceBaseFormat(format: number): void;
  add(record: StoredWebDispatch, baseFormat: number): void;
  all(): StoredWebDispatch[];
}
export function sqliteWebTables(db: Database): WebTables {
  const run = (sql: string, ...args: any[]) => { const stmt = db.prepare(sql); try { return stmt.run(...args); } finally { stmt.finalize(); } };
  const get = (sql: string, ...args: any[]) => { const stmt = db.prepare(sql); try { return stmt.get(...args) as any; } finally { stmt.finalize(); } };
  const all = (sql: string) => { const stmt = db.prepare(sql); try { return stmt.all() as any[]; } finally { stmt.finalize(); } };
  const present = () => !!get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='web_dispatch'");
  return {
    baseFormat() { const row = get("SELECT value FROM meta WHERE key='webBaseFormat'"); return row ? Number(row.value) : undefined; },
    advanceBaseFormat(format) { if (present()) run("UPDATE meta SET value=? WHERE key='webBaseFormat' AND CAST(value AS INTEGER) < ?", String(format), format); },
    add(record, base) {
      if (!present()) {
        if (![6,7,8,9].includes(base)) throw new Error("Invalid web base format");
        db.exec("CREATE TABLE web_dispatch (turn_id INTEGER NOT NULL, call_id TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(turn_id,call_id)) WITHOUT ROWID");
        run("INSERT INTO meta(key,value) VALUES('webBaseFormat',?)", String(base));
      }
      run("INSERT INTO web_dispatch VALUES (?,?,?)", record.turnId, record.callId, JSON.stringify(record.evidence));
    },
    all() { return present() ? all("SELECT turn_id,call_id,evidence FROM web_dispatch ORDER BY turn_id,call_id").map(row => ({ turnId: Number(row.turn_id), callId: row.call_id, evidence: JSON.parse(row.evidence) })) : []; },
  };
}
export function memoryWebTables(state: { base?: number; records: Map<string, StoredWebDispatch> }, log: (undo: () => void) => void): WebTables {
  return {
    baseFormat: () => state.base,
    advanceBaseFormat(format) { if (state.base !== undefined && state.base < format) { const previous = state.base; log(() => { state.base = previous; }); state.base = format; } },
    add(record, base) {
      if (state.base === undefined) { if (![6,7,8,9].includes(base)) throw new Error("Invalid web base format"); log(() => { state.base = undefined; }); state.base = base; }
      const key = JSON.stringify([record.turnId, record.callId]);
      if (state.records.has(key)) throw new Error("Duplicate web dispatch");
      log(() => { state.records.delete(key); }); state.records.set(key, structuredClone(record));
    },
    all: () => [...state.records.values()].sort((a, b) => a.turnId - b.turnId || a.callId.localeCompare(b.callId)).map(value => structuredClone(value)),
  };
}
