// Standalone session persistence — filesystem ops, NO live connection needed.
// The library is NOT the source of truth for sessions (the ACP implementation is); these
// are small metadata files the library reads/writes. See SPEC.md "Sessions".

import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRecord {
  sessionId: string;
  adapter?: string;
  createdAt: string;
  lastUsedAt: string;
}

const FILE_RE = /\.json$/;

/** List stored session records in a directory, newest lastUsedAt first. */
export async function listSessions(sessionsDir: string): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    try {
      const raw = await readFile(join(sessionsDir, name), "utf8");
      records.push(JSON.parse(raw) as SessionRecord);
    } catch {
      /* skip unreadable / malformed */
    }
  }
  records.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  return records;
}

/** Write/update a session record. */
export async function saveSession(
  sessionsDir: string,
  record: SessionRecord,
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `${record.sessionId}.json`),
    JSON.stringify(record, null, 2),
    "utf8",
  );
}

/** Delete a stored session record (filesystem only — see capabilities for protocol delete). */
export async function deleteSession(
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  try {
    await unlink(join(sessionsDir, `${sessionId}.json`));
  } catch {
    /* already gone */
  }
}
