import { Database } from "bun:sqlite";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const heldOwnershipKeys = new Set<string>();

export class SqliteOwnerLockConflictError extends Error {
  readonly ownershipKey: string;
  readonly lockPath: string;

  constructor(ownershipKey: string, lockPath: string, options?: ErrorOptions) {
    super(`SQLite ownership is already held for ${ownershipKey}`, options);
    this.name = "SqliteOwnerLockConflictError";
    this.ownershipKey = ownershipKey;
    this.lockPath = lockPath;
  }
}

/**
 * Process-lifetime ownership backed by SQLite's own cross-process file locks.
 *
 * The sidecar contains no application state. Its live connection is the lock, while the
 * file itself may safely remain after close or process termination.
 */
export class SqliteOwnerLock {
  private closed = false;

  private constructor(
    readonly ownershipKey: string,
    readonly lockPath: string,
    private readonly database: Database,
  ) {}

  static async acquire(ownershipKey: string, lockPath: string): Promise<SqliteOwnerLock> {
    if (heldOwnershipKeys.has(ownershipKey)) {
      throw new SqliteOwnerLockConflictError(ownershipKey, lockPath);
    }

    let database: Database | undefined;
    try {
      database = new Database(lockPath, { create: true, readwrite: true, strict: true });
      database.exec("PRAGMA busy_timeout = 0");
      const lockingMode = database.query<{ locking_mode: string }, []>(
        "PRAGMA locking_mode = EXCLUSIVE",
      ).get()?.locking_mode;
      if (lockingMode?.toLowerCase() !== "exclusive") {
        throw new Error(`SQLite ownership sidecar did not enter exclusive mode: ${lockPath}`);
      }

      database.exec("BEGIN EXCLUSIVE");
      database.exec(`
        CREATE TABLE IF NOT EXISTS owner_probe (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_token TEXT NOT NULL,
          acquired_at TEXT NOT NULL
        )
      `);
      database.query<unknown, [string, string]>(
        `INSERT INTO owner_probe(singleton, owner_token, acquired_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           owner_token = excluded.owner_token,
           acquired_at = excluded.acquired_at`,
      ).run(randomUUID(), new Date().toISOString());
      database.exec("COMMIT");

      // Retain the Database instance: exclusive mode keeps its file lock until close.
      await chmod(lockPath, 0o600);
      heldOwnershipKeys.add(ownershipKey);
      return new SqliteOwnerLock(ownershipKey, lockPath, database);
    } catch (error) {
      if (database?.inTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the acquisition failure.
        }
      }
      try {
        database?.close();
      } catch {
        // Preserve the acquisition failure.
      }
      if (error instanceof SqliteOwnerLockConflictError || isSqliteLockConflict(error)) {
        throw new SqliteOwnerLockConflictError(ownershipKey, lockPath, { cause: error });
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      heldOwnershipKeys.delete(this.ownershipKey);
    }
  }
}

function isSqliteLockConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
