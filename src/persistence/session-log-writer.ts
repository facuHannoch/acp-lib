import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  validateAuditLogRecord,
  validateTranscriptRecord,
  type AuditLogHeaderRecord,
  type KnownAuditLogRecord,
  type KnownTranscriptRecord,
  type SessionLogRecordExpectation,
  type TranscriptHeaderRecord,
} from "./records.ts";
import { truncateSessionLogRecord } from "./truncation.ts";
import type { PersistenceLimits } from "./config.ts";
import {
  scanTranscriptContinuation,
  TranscriptNotFoundError,
  TranscriptUnavailableError,
  type TranscriptContinuationScan,
  type TranscriptScanExpectation,
} from "./transcript-scanner.ts";

export type SessionLogKind = "transcript" | "audit";

export interface FileSessionLogWriterOptions<K extends SessionLogKind> {
  readonly kind: K;
  readonly path: string;
  readonly header: K extends "transcript" ? TranscriptHeaderRecord : AuditLogHeaderRecord;
  readonly maxRecordBytes: number;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface ResumeTranscriptWriterOptions {
  readonly path: string;
  readonly expected?: TranscriptScanExpectation;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface ResumedTranscriptWriter {
  readonly writer: FileSessionLogWriter<"transcript">;
  readonly scan: TranscriptContinuationScan;
}

export class SessionLogWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionLogWriteError";
  }
}

export class SessionLogAlreadyExistsError extends SessionLogWriteError {
  constructor(readonly path: string) {
    super(`session log is already initialized: ${path}`);
    this.name = "SessionLogAlreadyExistsError";
  }
}

export class SessionLogInUseError extends SessionLogWriteError {
  constructor(readonly path: string) {
    super(`session log is already owned by another writer: ${path}`);
    this.name = "SessionLogInUseError";
  }
}

export class SessionLogRecordTooLargeError extends SessionLogWriteError {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`session-log record is ${bytes} bytes; limit is ${limit}`);
    this.name = "SessionLogRecordTooLargeError";
  }
}

/** One lifetime-owned append-only transcript or audit-log generation. */
export class FileSessionLogWriter<K extends SessionLogKind> {
  readonly kind: K;
  readonly path: string;
  readonly maxRecordBytes: number;
  private readonly limits: PersistenceLimits;
  private readonly includeTruncationDigests: boolean;
  private readonly handle: FileHandle;
  private readonly lock: OwnedLogLock;
  private readonly expected: SessionLogRecordExpectation;
  private sequence: number;
  private closed = false;
  private failure: SessionLogWriteError | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    options: FileSessionLogWriterOptions<K>,
    handle: FileHandle,
    lock: OwnedLogLock,
    initialSequence = options.header.seq,
  ) {
    this.kind = options.kind;
    this.path = options.path;
    this.maxRecordBytes = options.maxRecordBytes;
    this.limits = options.header.effectiveLimits;
    this.includeTruncationDigests = options.header.includeTruncationDigests;
    this.handle = handle;
    this.lock = lock;
    this.sequence = initialSequence;
    this.expected = {
      agentSessionId: options.header.agentSessionId,
      logId: options.kind === "transcript"
        ? (options.header as TranscriptHeaderRecord).transcriptId
        : (options.header as AuditLogHeaderRecord).auditLogId,
      generation: options.header.generation,
      ...(options.kind === "transcript" ? { transcriptPath: options.path } : {}),
    };
  }

  static async create<K extends SessionLogKind>(
    options: FileSessionLogWriterOptions<K>,
  ): Promise<FileSessionLogWriter<K>> {
    validateWriterOptions(options);
    const parent = dirname(options.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700).catch(() => undefined);
    const lock = await acquireLogLock(
      `${options.path}.lock`,
      options.path,
      options.lockTimeoutMs ?? 5_000,
      options.lockRetryMs ?? 20,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await openUninitializedFile(options.path);
      const writer = new FileSessionLogWriter(options, handle, lock);
      await writer.writeRecord(options.header, true);
      return writer;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await lock.release();
      throw error;
    }
  }

  /** Own and resume one validated transcript generation, discarding only a torn suffix. */
  static async resumeTranscript(
    options: ResumeTranscriptWriterOptions,
  ): Promise<ResumedTranscriptWriter> {
    if (!isAbsolute(options.path)) throw new SessionLogWriteError("session-log path must be absolute");
    await inspectResumableTranscript(options.path);
    const lock = await acquireLogLock(
      `${options.path}.lock`,
      options.path,
      options.lockTimeoutMs ?? 5_000,
      options.lockRetryMs ?? 20,
    );
    let handle: FileHandle | undefined;
    try {
      const before = await inspectResumableTranscript(options.path);
      const scan = await scanTranscriptContinuation(options.path, options.expected);
      handle = await open(options.path, "a+");
      const owned = await handle.stat();
      if (owned.dev !== before.dev || owned.ino !== before.ino || owned.size !== scan.snapshotBytes) {
        throw new TranscriptUnavailableError("transcript changed while append ownership was being acquired");
      }
      if (scan.ignoredTrailingBytes > 0) {
        await handle.truncate(scan.lastCompleteOffset);
        await handle.sync();
      }
      await chmod(options.path, 0o600).catch(() => undefined);
      const writerOptions: FileSessionLogWriterOptions<"transcript"> = {
        kind: "transcript",
        path: options.path,
        header: scan.header,
        maxRecordBytes: scan.header.effectiveLimits.maxRecordBytes,
        lockTimeoutMs: options.lockTimeoutMs,
        lockRetryMs: options.lockRetryMs,
      };
      const writer = new FileSessionLogWriter(writerOptions, handle, lock, scan.lastCompleteSequence);
      return { writer, scan };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await lock.release();
      throw error;
    }
  }

  get nextSequence(): number {
    return this.sequence + 1;
  }

  append(
    record: K extends "transcript" ? KnownTranscriptRecord : KnownAuditLogRecord,
    options: { readonly durable?: boolean } = {},
  ): Promise<void> {
    const run = this.queue.then(async () => {
      this.assertOpen();
      if (record.seq !== this.sequence + 1) {
        throw new SessionLogWriteError(`expected session-log sequence ${this.sequence + 1}, received ${record.seq}`);
      }
      await this.writeRecord(record, options.durable ?? false);
      this.sequence = record.seq;
    });
    // Keep the serialization chain usable after a rejected caller operation.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async sync(): Promise<void> {
    await this.queue;
    this.assertOpen();
    try {
      await this.handle.sync();
    } catch (error) {
      this.failure = new SessionLogWriteError("session-log synchronization failed", { cause: error });
      throw this.failure;
    }
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    try {
      await this.handle.sync();
    } finally {
      await this.handle.close().catch(() => undefined);
      await this.lock.release();
    }
  }

  private async writeRecord(record: KnownTranscriptRecord | KnownAuditLogRecord, durable: boolean): Promise<void> {
    const bounded = truncateSessionLogRecord(record, {
      limits: this.limits,
      includeTruncationDigests: this.includeTruncationDigests,
    });
    try {
      if (this.kind === "transcript") validateTranscriptRecord(bounded, this.expected);
      else validateAuditLogRecord(bounded, this.expected);
    } catch (error) {
      throw new SessionLogWriteError("session-log record validation failed", { cause: error });
    }
    const line = `${JSON.stringify(bounded)}\n`;
    const bytes = Buffer.byteLength(line, "utf8") - 1;
    if (bytes > this.maxRecordBytes) throw new SessionLogRecordTooLargeError(bytes, this.maxRecordBytes);
    try {
      const result = await this.handle.write(line);
      if (result.bytesWritten !== Buffer.byteLength(line, "utf8")) {
        throw new Error(`short append: ${result.bytesWritten} bytes`);
      }
      if (durable) await this.handle.sync();
    } catch (error) {
      this.failure = new SessionLogWriteError("session-log append or synchronization failed", { cause: error });
      throw this.failure;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionLogWriteError("session-log writer is closed");
    if (this.failure) throw this.failure;
  }
}

async function inspectResumableTranscript(path: string) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TranscriptNotFoundError(path);
    throw new TranscriptUnavailableError(`cannot inspect transcript before resume: ${path}`, { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TranscriptUnavailableError(`transcript is not a regular non-symbolic file: ${path}`);
  }
  return info;
}

function validateWriterOptions(options: FileSessionLogWriterOptions<SessionLogKind>): void {
  if (!isAbsolute(options.path)) throw new SessionLogWriteError("session-log path must be absolute");
  if (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 4_096 || options.maxRecordBytes > 16_777_216) {
    throw new SessionLogWriteError("maxRecordBytes is outside the supported range");
  }
  if (options.header.seq !== 1) throw new SessionLogWriteError("a new session-log header must use sequence 1");
  if (options.header.generation < 1) throw new SessionLogWriteError("session-log generation must be positive");
  if (options.header.effectiveLimits.maxRecordBytes !== options.maxRecordBytes) {
    throw new SessionLogWriteError("writer maxRecordBytes must equal the limit engraved in its header");
  }
  if (options.kind === "transcript") {
    const header = options.header as TranscriptHeaderRecord;
    validateTranscriptRecord(header, {
      agentSessionId: header.agentSessionId,
      logId: header.transcriptId,
      generation: header.generation,
    });
  } else {
    const header = options.header as AuditLogHeaderRecord;
    validateAuditLogRecord(header, {
      agentSessionId: header.agentSessionId,
      logId: header.auditLogId,
      generation: header.generation,
    });
  }
}

async function openUninitializedFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SessionLogWriteError(`cannot create session log: ${path}`, { cause: error });
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) throw new SessionLogAlreadyExistsError(path);
  const handle = await open(path, "r+");
  await chmod(path, 0o600).catch(() => undefined);
  // Recheck through the owned descriptor to close the stat/open race.
  if ((await handle.stat()).size !== 0) {
    await handle.close();
    throw new SessionLogAlreadyExistsError(path);
  }
  return handle;
}

interface OwnedLogLock { release(): Promise<void> }
async function acquireLogLock(
  lockPath: string,
  targetPath: string,
  timeoutMs: number,
  retryMs: number,
): Promise<OwnedLogLock> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || !Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw new SessionLogWriteError("session-log lock timing is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SessionLogWriteError("cannot acquire session-log lock", { cause: error });
      if (await removeDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new SessionLogInUseError(targetPath);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw new SessionLogWriteError("cannot initialize session-log lock", { cause: error });
    }
    return {
      release: async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
          if (current.token === token) await unlink(lockPath);
        } catch {
          // Never remove a replacement lock.
        }
      },
    };
  }
}

async function removeDeadLock(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.token !== "string") return false;
    try { process.kill(value.pid as number, 0); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    if (await readFile(path, "utf8") !== raw) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}
