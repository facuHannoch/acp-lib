import { open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { canonicalizeJson, sha256CanonicalJson } from "../persistence/integrity.ts";
import { resolveAgentAuditLogConfig } from "./config.ts";
import {
  AGENT_AUDIT_BATCH_SIZE,
  type AgentAuditEntryV2,
  type AgentAuditSegmentHeaderV2,
} from "./runtime.ts";

const MAX_CURSOR_BYTES = 4_096;
const MAX_LINE_BYTES = 1_048_576;

export type AgentAuditReadMode = "logical" | "physical";

export interface AgentAuditLogReaderConfig {
  readonly directory: string;
  readonly filePrefix?: string;
}

export interface AgentAuditReadPageOptions {
  readonly mode?: AgentAuditReadMode;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AgentAuditReadPage {
  readonly entries: readonly AgentAuditEntryV2[];
  readonly nextCursor?: string;
}

interface ReaderTuple {
  readonly sequence: number;
  readonly outboxId: string;
  readonly payloadSha256: string;
}

interface ReaderCursor {
  readonly v: 1;
  readonly auditLogId: string;
  readonly agentSessionId: string;
  readonly mode: AgentAuditReadMode;
  readonly snapshotGeneration: number;
  readonly snapshotOffset: number;
  readonly generation: number;
  readonly byteOffset: number;
  readonly logicalSequence: number;
  readonly recent: readonly ReaderTuple[];
  readonly replayLength: number;
  readonly replayLastSequence: number;
}

export class AgentAuditLogReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentAuditLogReaderError";
  }
}

export class AgentAuditLogReader {
  private constructor(
    readonly directory: string,
    readonly filePrefix: string,
  ) {}

  static async open(config: AgentAuditLogReaderConfig): Promise<AgentAuditLogReader> {
    const resolved = resolveAgentAuditLogConfig({
      directory: config.directory,
      ...(config.filePrefix ? { filePrefix: config.filePrefix } : {}),
    });
    let directory: string;
    try {
      directory = await realpath(resolved.directory);
    } catch (error) {
      throw new AgentAuditLogReaderError(`audit directory is unavailable: ${resolved.directory}`, { cause: error });
    }
    return new AgentAuditLogReader(directory, resolved.filePrefix);
  }

  async readPage(options: AgentAuditReadPageOptions = {}): Promise<AgentAuditReadPage> {
    const mode = options.mode ?? "logical";
    if (mode !== "logical" && mode !== "physical") throw new AgentAuditLogReaderError(`invalid reader mode: ${mode}`);
    const limit = boundedLimit(options.limit ?? 100);
    const segments = await listSegments(this.directory, this.filePrefix);
    if (segments.length === 0) throw new AgentAuditLogReaderError("audit stream contains no segments");

    let cursor: ReaderCursor;
    if (options.cursor) {
      cursor = decodeCursor(options.cursor);
      if (cursor.mode !== mode) throw new AgentAuditLogReaderError("audit cursor mode does not match request");
      if (segments.length < cursor.snapshotGeneration) {
        throw new AgentAuditLogReaderError("audit snapshot segments are missing");
      }
      const finalSize = await fileSize(join(this.directory, segmentName(this.filePrefix, cursor.snapshotGeneration)));
      if (finalSize < cursor.snapshotOffset) throw new AgentAuditLogReaderError("audit snapshot boundary was truncated");
    } else {
      const snapshotGeneration = segments.length;
      const snapshotOffset = await fileSize(join(this.directory, segments.at(-1)!.name));
      const firstHeader = await readHeader(
        join(this.directory, segments[0]!.name),
        segments[0]!.generation,
      );
      cursor = {
        v: 1,
        auditLogId: firstHeader.header.auditLogId,
        agentSessionId: firstHeader.header.agentSessionId,
        mode,
        snapshotGeneration,
        snapshotOffset,
        generation: 1,
        byteOffset: firstHeader.nextOffset,
        logicalSequence: 0,
        recent: [],
        replayLength: 0,
        replayLastSequence: 0,
      };
    }

    const entries: AgentAuditEntryV2[] = [];
    let position = { ...cursor };
    while (entries.length < limit && position.generation <= position.snapshotGeneration) {
      const path = join(this.directory, segmentName(this.filePrefix, position.generation));
      const boundary = position.generation === position.snapshotGeneration
        ? position.snapshotOffset
        : await fileSize(path);
      const segmentHeader = await readHeader(path, position.generation);
      if (position.byteOffset === 0) {
        const header = segmentHeader;
        assertHeaderIdentity(header.header, position);
        position = { ...position, byteOffset: header.nextOffset };
      } else {
        assertHeaderIdentity(segmentHeader.header, position);
      }
      if (position.byteOffset > boundary) throw new AgentAuditLogReaderError(`audit segment was truncated: ${path}`);
      if (position.byteOffset === boundary) {
        position = { ...position, generation: position.generation + 1, byteOffset: 0 };
        continue;
      }

      const handle = await open(path, "r");
      try {
        while (entries.length < limit && position.byteOffset < boundary) {
          const physical = await readLine(handle, position.byteOffset, boundary, path);
          const entry = parseEntry(physical.line, path, position.auditLogId, position.agentSessionId);
          if (
            position.byteOffset === segmentHeader.nextOffset
            && entry.auditSequence !== segmentHeader.header.firstAuditSequence
          ) throw new AgentAuditLogReaderError(`audit segment first sequence is incorrect: ${path}`);
          const update = advanceLogicalState(position, entry);
          const { duplicate, ...logicalState } = update;
          position = { ...position, ...logicalState, byteOffset: physical.nextOffset };
          if (mode === "physical" || !duplicate) entries.push(entry);
        }
      } finally {
        await handle.close();
      }
      if (position.byteOffset === boundary && position.generation < position.snapshotGeneration) {
        position = { ...position, generation: position.generation + 1, byteOffset: 0 };
      }
    }

    const more = position.generation <= position.snapshotGeneration && (
      position.generation < position.snapshotGeneration || position.byteOffset < position.snapshotOffset
    );
    return Object.freeze({
      entries: Object.freeze(entries),
      ...(more ? { nextCursor: encodeCursor(position) } : {}),
    });
  }
}

async function listSegments(directory: string, prefix: string) {
  const matcher = new RegExp(`^${escapeRegExp(prefix)}\\.([0-9]{6,})\\.jsonl$`);
  const segments = (await readdir(directory))
    .map((name) => ({ name, match: matcher.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .map(({ name, match }) => ({ name, generation: Number(match[1]) }))
    .sort((left, right) => left.generation - right.generation);
  for (let index = 0; index < segments.length; index++) {
    if (segments[index]!.generation !== index + 1) {
      throw new AgentAuditLogReaderError("audit segment generations are not contiguous from one");
    }
  }
  return segments;
}

async function readHeader(path: string, generation: number) {
  const handle = await open(path, "r");
  try {
    const physical = await readLine(handle, 0, (await handle.stat()).size, path);
    let value: unknown;
    try {
      value = JSON.parse(physical.line);
    } catch (error) {
      throw new AgentAuditLogReaderError(`malformed audit header: ${path}`, { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentAuditLogReaderError(`invalid audit header: ${path}`);
    }
    const header = value as unknown as AgentAuditSegmentHeaderV2;
    if (
      header.v !== 2 || header.t !== "header" || header.generation !== generation
      || typeof header.auditLogId !== "string" || typeof header.agentSessionId !== "string"
      || !Number.isSafeInteger(header.firstAuditSequence) || header.firstAuditSequence < 1
      || !Number.isFinite(Date.parse(header.createdAt))
    ) throw new AgentAuditLogReaderError(`invalid audit header: ${path}`);
    return { header, nextOffset: physical.nextOffset };
  } finally {
    await handle.close();
  }
}

function assertHeaderIdentity(header: AgentAuditSegmentHeaderV2, cursor: ReaderCursor): void {
  if (header.auditLogId !== cursor.auditLogId || header.agentSessionId !== cursor.agentSessionId) {
    throw new AgentAuditLogReaderError("audit segment identity changed within the stream");
  }
}

async function readLine(
  handle: FileHandle,
  offset: number,
  boundary: number,
  path: string,
): Promise<{ line: string; nextOffset: number }> {
  const chunks: Buffer[] = [];
  let cursor = offset;
  let total = 0;
  while (cursor < boundary) {
    const size = Math.min(64 * 1024, boundary - cursor, MAX_LINE_BYTES + 1 - total);
    if (size <= 0) throw new AgentAuditLogReaderError(`audit line exceeds ${MAX_LINE_BYTES} bytes: ${path}`);
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, cursor);
    if (bytesRead === 0) break;
    const slice = buffer.subarray(0, bytesRead);
    const newline = slice.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(slice.subarray(0, newline));
      return { line: Buffer.concat(chunks).toString("utf8"), nextOffset: cursor + newline + 1 };
    }
    chunks.push(slice);
    cursor += bytesRead;
    total += bytesRead;
  }
  throw new AgentAuditLogReaderError(`torn audit tail at byte ${offset}: ${path}`);
}

function parseEntry(line: string, path: string, auditLogId: string, agentSessionId: string): AgentAuditEntryV2 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AgentAuditLogReaderError(`malformed audit entry: ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentAuditLogReaderError(`invalid audit entry: ${path}`);
  }
  const entry = value as unknown as AgentAuditEntryV2;
  if (
    entry.v !== 2 || entry.t !== "audit" || entry.auditLogId !== auditLogId
    || entry.agentSessionId !== agentSessionId || typeof entry.outboxId !== "string" || !entry.outboxId
    || !Number.isSafeInteger(entry.auditSequence) || entry.auditSequence < 1
    || typeof entry.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.payloadSha256)
    || sha256CanonicalJson(entry.payload) !== entry.payloadSha256
  ) throw new AgentAuditLogReaderError(`audit entry failed validation: ${path}`);
  return Object.freeze(entry);
}

function advanceLogicalState(cursor: ReaderCursor, entry: AgentAuditEntryV2) {
  const tuple: ReaderTuple = {
    sequence: entry.auditSequence,
    outboxId: entry.outboxId,
    payloadSha256: entry.payloadSha256,
  };
  if (entry.auditSequence === cursor.logicalSequence + 1) {
    return {
      logicalSequence: entry.auditSequence,
      recent: Object.freeze([...cursor.recent, tuple].slice(-AGENT_AUDIT_BATCH_SIZE)),
      replayLength: 0,
      replayLastSequence: 0,
      duplicate: false,
    };
  }
  const original = cursor.recent.find((candidate) => candidate.sequence === entry.auditSequence);
  if (
    !original || original.outboxId !== entry.outboxId || original.payloadSha256 !== entry.payloadSha256
    || (cursor.replayLength > 0 && entry.auditSequence !== cursor.replayLastSequence + 1)
    || cursor.replayLength + 1 > AGENT_AUDIT_BATCH_SIZE
  ) throw new AgentAuditLogReaderError(`conflicting or out-of-window audit sequence ${entry.auditSequence}`);
  return {
    logicalSequence: cursor.logicalSequence,
    recent: cursor.recent,
    replayLength: cursor.replayLength + 1,
    replayLastSequence: entry.auditSequence,
    duplicate: true,
  };
}

function encodeCursor(cursor: ReaderCursor): string {
  const encoded = Buffer.from(canonicalizeJson(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) {
    throw new AgentAuditLogReaderError("audit cursor exceeds its safety limit");
  }
  return encoded;
}

function decodeCursor(encoded: string): ReaderCursor {
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) {
    throw new AgentAuditLogReaderError("audit cursor exceeds its safety limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw new AgentAuditLogReaderError("audit cursor is malformed", { cause: error });
  }
  if (!isReaderCursor(value)) throw new AgentAuditLogReaderError("audit cursor is invalid");
  return value;
}

function isReaderCursor(value: unknown): value is ReaderCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return cursor.v === 1 && typeof cursor.auditLogId === "string" && typeof cursor.agentSessionId === "string"
    && (cursor.mode === "logical" || cursor.mode === "physical")
    && safePositive(cursor.snapshotGeneration) && safeNonNegative(cursor.snapshotOffset)
    && safePositive(cursor.generation) && safeNonNegative(cursor.byteOffset)
    && safeNonNegative(cursor.logicalSequence) && Array.isArray(cursor.recent)
    && cursor.recent.length <= AGENT_AUDIT_BATCH_SIZE
    && cursor.recent.every(isReaderTuple) && safeNonNegative(cursor.replayLength)
    && cursor.replayLength <= AGENT_AUDIT_BATCH_SIZE && safeNonNegative(cursor.replayLastSequence);
}

function isReaderTuple(value: unknown): value is ReaderTuple {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tuple = value as Record<string, unknown>;
  return safePositive(tuple.sequence) && typeof tuple.outboxId === "string"
    && typeof tuple.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(tuple.payloadSha256);
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new AgentAuditLogReaderError("audit page limit must be an integer between 1 and 1000");
  }
  return value;
}

async function fileSize(path: string): Promise<number> {
  const handle = await open(path, "r");
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

function safePositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safeNonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function segmentName(prefix: string, generation: number): string {
  return `${prefix}.${String(generation).padStart(6, "0")}.jsonl`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
