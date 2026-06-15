// Session catalog storage. The library is NOT the source of truth for conversation
// CONTENT (the agent persists that; loadSession replays it) — this is a routing catalog:
// which adapter/mode/cwd a session belongs to, keyed by OUR stable id. That's the part
// the agent can't tell us, and it survives a broken agent `session/list` (e.g. kimi).
//
// `SessionStore` is an interface so consumers (the orchestration hub) can back it with
// their own database instead of files — same injection pattern as Logger. The library
// ships FileSessionStore as the default. See SPEC.md "Sessions".

import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  /** OUR stable catalog id (a uuid). Decoupled from the agent's sessionId on purpose. */
  id: string;
  /**
   * The agent's protocol sessionId. Null in degraded mode (no protocol session), and it
   * CHANGES on mode-swap (the pty session ≠ the ACP session). Kept as a mutable field so
   * a future portable conversation can span several agent sessions without re-keying.
   */
  agentSessionId: string | null;
  /** Which adapter this session belongs to — the routing the agent's own list can't give. */
  adapter: string;
  mode: "normal" | "degraded";
  cwd?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  // (transcript storage slots in here later without breaking the schema.)
}

export interface SessionStore {
  save(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
  delete(id: string): Promise<void>;
}

/** Default location for the file store. Overridable; the hub injects its own store. */
export function defaultSessionsDir(): string {
  return join(homedir(), ".acp-lib", "sessions");
}

/** File-per-session catalog under a directory. One `<id>.json` per record. */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dir: string = defaultSessionsDir()) {
    this.dir = dir;
  }

  async save(record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async get(id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as SessionRecord);
      } catch {
        /* skip malformed */
      }
    }
    return records;
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.path(id));
    } catch {
      /* already gone */
    }
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }
}
