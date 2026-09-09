import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { JsonObject } from "./checkpoint.ts";
import { canonicalizeJson } from "./integrity.ts";
import {
  validateAuditLogRecord,
  type AuditLogHeaderRecord,
  type AuditLogRecordType,
  type KnownAuditLogRecord,
  type UnknownAuditLogRecord,
} from "./records.ts";
import {
  SESSION_LOG_READER_INTERNALS as IO,
  TranscriptCursorInvalidError,
  TranscriptReaderError,
  type SessionLogPhysicalLine,
  type TranscriptPage,
} from "./transcript-reader.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const CURSOR_VERSION = 1;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const AUDIT_TYPE_ORDER: readonly AuditLogRecordType[] = Object.freeze([
  "header", "operation", "reasoning", "activity", "configuration", "permission",
  "transition", "metering_reference", "lifecycle",
]);
const AUDIT_TYPES = new Set(AUDIT_TYPE_ORDER);

export type AuditLogCursor = string & { readonly __auditLogCursor: unique symbol };
export type AuditLogSnapshotCursor = string & { readonly __auditLogSnapshotCursor: unique symbol };

export interface ReadAuditLogPageOptions {
  readonly cursor?: AuditLogCursor;
  readonly limit?: number;
  readonly types?: readonly AuditLogRecordType[];
}

export class AuditLogCursorInvalidError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditLogCursorInvalidError";
  }
}

export class AuditLogReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditLogReaderError";
  }
}

interface SnapshotBoundary {
  readonly id: string;
  readonly generation: number;
  readonly highSequence: number;
  readonly highOffset: number;
  readonly prefixDigest: string;
}

interface SnapshotPayload extends SnapshotBoundary {
  readonly kind: "snapshot";
}

interface NavigationPayload extends SnapshotBoundary {
  readonly kind: "navigation";
  readonly direction: "older" | "newer";
  readonly boundarySequence: number;
  readonly boundaryStart: number;
  readonly boundaryEnd: number;
  readonly boundaryDigest: string;
  readonly types: readonly AuditLogRecordType[];
  readonly filterProvided: boolean;
}

interface PhysicalRecord {
  readonly item: KnownAuditLogRecord | UnknownAuditLogRecord;
  readonly sequence: number;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
}

interface SnapshotContext {
  readonly handle: FileHandle;
  readonly header: AuditLogHeaderRecord;
  readonly payload: SnapshotPayload;
  readonly snapshotCursor: AuditLogSnapshotCursor;
  readonly navigation: NavigationPayload | null;
}

interface TypeFilter {
  readonly provided: boolean;
  readonly types: readonly AuditLogRecordType[];
}

/** Snapshot-bound, cursor-paginated reader for one audit-log generation. */
export class AuditLogReader {
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new AuditLogReaderError("audit-log reader path must be absolute");
  }

  async readPage(
    options: ReadAuditLogPageOptions = {},
  ): Promise<TranscriptPage<KnownAuditLogRecord | UnknownAuditLogRecord, AuditLogCursor, AuditLogSnapshotCursor>> {
    const limit = validatedLimit(options.limit);
    const filter = normalizeTypes(options.types);
    const snapshot = await this.openSnapshot(options.cursor);
    try {
      const navigation = snapshot.navigation;
      if (navigation) {
        if (navigation.filterProvided !== filter.provided
          || canonicalizeJson(navigation.types) !== canonicalizeJson(filter.types)) {
          throw new AuditLogCursorInvalidError("audit-log cursor type filter changed");
        }
        await validateBoundary(snapshot.handle, snapshot.header, navigation);
      }

      let selected: PhysicalRecord[];
      let hasOlder: boolean;
      let hasNewer: boolean;
      if (!navigation || navigation.direction === "older") {
        const matches = await collectBackward(
          snapshot.handle,
          snapshot.header,
          navigation?.boundaryStart ?? snapshot.payload.highOffset,
          limit + 1,
          navigation ? navigation.boundarySequence - 1 : snapshot.payload.highSequence,
          filter,
        );
        hasOlder = matches.length > limit;
        selected = matches.slice(0, limit).reverse();
        hasNewer = navigation !== null;
      } else {
        const matches = await collectForward(
          snapshot.handle,
          snapshot.header,
          navigation.boundaryEnd,
          snapshot.payload.highOffset,
          limit + 1,
          navigation.boundarySequence + 1,
          filter,
        );
        hasOlder = true;
        hasNewer = matches.length > limit;
        selected = matches.slice(0, limit);
      }

      const first = selected[0];
      const last = selected.at(-1);
      return Object.freeze({
        items: Object.freeze(selected.map(({ item }) => structuredClone(item))),
        olderCursor: hasOlder && first
          ? boundedNavigationCursor(encodeNavigation(snapshot.payload, "older", first, filter), snapshot.header)
          : null,
        newerCursor: hasNewer && last
          ? boundedNavigationCursor(encodeNavigation(snapshot.payload, "newer", last, filter), snapshot.header)
          : null,
        hasOlder,
        hasNewer,
        snapshot: snapshot.snapshotCursor,
      });
    } catch (error) {
      throw translateError(error);
    } finally {
      await snapshot.handle.close().catch(() => undefined);
    }
  }

  private async openSnapshot(cursor: AuditLogCursor | undefined): Promise<SnapshotContext> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      throw new AuditLogReaderError(`cannot open audit log: ${this.path}`, { cause: error });
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AuditLogReaderError("audit-log reader target is not a regular file");
      const header = await readHeader(handle, stat.size);
      let payload: SnapshotPayload;
      let navigation: NavigationPayload | null = null;
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor, header.effectiveLimits.maxCursorBytes);
        payload = snapshotFrom(decoded);
        navigation = decoded;
        validateSnapshot(payload, header, stat.size);
        if (await IO.digestPrefix(handle, payload.highOffset) !== payload.prefixDigest) {
          throw new AuditLogCursorInvalidError("audit-log content changed before the cursor snapshot boundary");
        }
        await validateHighBoundary(handle, header, payload);
      } else {
        const highOffset = await IO.lastCompleteOffset(handle, stat.size);
        if (highOffset === 0) throw new AuditLogReaderError("audit log has no complete records");
        const high = parsePhysical(
          await IO.readLastPhysical(handle, highOffset, header.effectiveLimits.maxRecordBytes),
          header,
        );
        payload = {
          kind: "snapshot",
          id: identityTag(header.auditLogId),
          generation: header.generation,
          highSequence: high.sequence,
          highOffset,
          prefixDigest: await IO.digestPrefix(handle, highOffset),
        };
      }
      return {
        handle,
        header,
        payload,
        snapshotCursor: boundedSnapshotCursor(encodeSnapshot(payload), header),
        navigation,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw translateError(error);
    }
  }
}

async function collectBackward(
  handle: FileHandle,
  header: AuditLogHeaderRecord,
  end: number,
  count: number,
  expectedFirstSequence: number,
  filter: TypeFilter,
): Promise<PhysicalRecord[]> {
  const output: PhysicalRecord[] = [];
  let expected = expectedFirstSequence;
  for await (const physical of IO.backwardLines(handle, end, header.effectiveLimits.maxRecordBytes)) {
    const parsed = parsePhysical(physical, header);
    if (parsed.sequence !== expected--) throw new AuditLogReaderError("audit-log sequence is not physically contiguous");
    if (!filter.provided || filter.types.includes(parsed.item.t as AuditLogRecordType)) output.push(parsed);
    if (output.length >= count) break;
  }
  return output;
}

async function collectForward(
  handle: FileHandle,
  header: AuditLogHeaderRecord,
  start: number,
  end: number,
  count: number,
  expectedFirstSequence: number,
  filter: TypeFilter,
): Promise<PhysicalRecord[]> {
  const output: PhysicalRecord[] = [];
  let expected = expectedFirstSequence;
  for await (const physical of IO.forwardLines(handle, start, end, header.effectiveLimits.maxRecordBytes)) {
    const parsed = parsePhysical(physical, header);
    if (parsed.sequence !== expected++) throw new AuditLogReaderError("audit-log sequence is not physically contiguous");
    if (!filter.provided || filter.types.includes(parsed.item.t as AuditLogRecordType)) output.push(parsed);
    if (output.length >= count) break;
  }
  return output;
}

function parsePhysical(physical: SessionLogPhysicalLine, header: AuditLogHeaderRecord): PhysicalRecord {
  if (physical.bytes.byteLength === 0) throw new AuditLogReaderError("audit log contains an empty record");
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(physical.bytes));
  } catch (error) {
    throw new AuditLogReaderError("audit log contains malformed UTF-8 or JSON", { cause: error });
  }
  if (!isRecord(value)) throw new AuditLogReaderError("audit-log record must be an object");
  if (value.v !== 1 || typeof value.t !== "string" || value.t.length === 0
    || value.auditLogId !== header.auditLogId || value.generation !== header.generation
    || value.agentSessionId !== header.agentSessionId || !IO.positiveInteger(value.seq)
    || !Number.isSafeInteger(value.ts)) {
    throw new AuditLogReaderError("audit-log record envelope is invalid or changes identity");
  }
  let item: KnownAuditLogRecord | UnknownAuditLogRecord;
  if (AUDIT_TYPES.has(value.t as AuditLogRecordType)) {
    try {
      validateAuditLogRecord(value, {
        agentSessionId: header.agentSessionId,
        logId: header.auditLogId,
        generation: header.generation,
      });
    } catch (error) {
      throw new AuditLogReaderError(`invalid audit-log record at sequence ${String(value.seq)}`, { cause: error });
    }
    item = value;
  } else {
    try {
      canonicalizeJson(value);
    } catch (error) {
      throw new AuditLogReaderError("unknown audit-log record is not canonical JSON", { cause: error });
    }
    item = {
      v: 1,
      t: value.t,
      auditLogId: header.auditLogId,
      generation: header.generation,
      agentSessionId: header.agentSessionId,
      seq: value.seq as number,
      ts: value.ts as number,
      value: structuredClone(value) as JsonObject,
    };
  }
  return {
    item,
    sequence: value.seq as number,
    start: physical.start,
    end: physical.end,
    digest: IO.sha256Bytes(physical.bytes),
  };
}

async function readHeader(handle: FileHandle, fileSize: number): Promise<AuditLogHeaderRecord> {
  if (fileSize === 0) throw new AuditLogReaderError("audit log is empty");
  const physical = await IO.firstPhysical(handle, fileSize);
  if (physical.bytes.byteLength > IO.hardMaxRecordBytes) throw new AuditLogReaderError("audit-log header exceeds safety ceiling");
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(physical.bytes));
    validateAuditLogRecord(value);
  } catch (error) {
    throw new AuditLogReaderError("audit-log header is invalid", { cause: error });
  }
  if (value.t !== "header" || value.seq !== 1) throw new AuditLogReaderError("first audit-log record is not its header");
  return value;
}

async function validateBoundary(
  handle: FileHandle,
  header: AuditLogHeaderRecord,
  cursor: NavigationPayload,
): Promise<void> {
  if (cursor.boundaryStart < 0 || cursor.boundaryEnd <= cursor.boundaryStart || cursor.boundaryEnd > cursor.highOffset) {
    throw new AuditLogCursorInvalidError("audit-log cursor boundary offsets are invalid");
  }
  const bytes = await IO.readBytes(handle, cursor.boundaryStart, cursor.boundaryEnd - cursor.boundaryStart);
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new AuditLogCursorInvalidError("audit-log cursor boundary is no longer a complete record");
  }
  let parsed: PhysicalRecord;
  try {
    parsed = parsePhysical({
      bytes: bytes.subarray(0, bytes.byteLength - 1),
      start: cursor.boundaryStart,
      end: cursor.boundaryEnd,
    }, header);
  } catch (error) {
    throw new AuditLogCursorInvalidError("audit-log cursor boundary is invalid", { cause: error });
  }
  if (parsed.sequence !== cursor.boundarySequence || parsed.digest !== cursor.boundaryDigest) {
    throw new AuditLogCursorInvalidError("audit-log cursor boundary changed");
  }
}

async function validateHighBoundary(
  handle: FileHandle,
  header: AuditLogHeaderRecord,
  cursor: SnapshotPayload,
): Promise<void> {
  try {
    const physical = await IO.readLastPhysical(handle, cursor.highOffset, header.effectiveLimits.maxRecordBytes);
    const parsed = parsePhysical(physical, header);
    if (parsed.sequence !== cursor.highSequence || physical.end !== cursor.highOffset) throw new Error("changed");
  } catch (error) {
    throw new AuditLogCursorInvalidError("audit-log cursor high-water boundary changed", { cause: error });
  }
}

function encodeSnapshot(payload: SnapshotPayload): string {
  return Buffer.from(JSON.stringify([
    CURSOR_VERSION, "as", payload.id, payload.generation, payload.highSequence,
    payload.highOffset, payload.prefixDigest,
  ]), "utf8").toString("base64url");
}

function encodeNavigation(
  snapshot: SnapshotPayload,
  direction: "older" | "newer",
  boundary: PhysicalRecord,
  filter: TypeFilter,
): string {
  return Buffer.from(JSON.stringify([
    CURSOR_VERSION, "an", snapshot.id, snapshot.generation, snapshot.highSequence,
    snapshot.highOffset, snapshot.prefixDigest, direction === "older" ? "o" : "n",
    boundary.sequence, boundary.start, boundary.end, boundary.digest,
    filter.provided ? typesMask(filter.types) : null,
  ]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, maxBytes: number): NavigationPayload {
  if (typeof cursor !== "string" || cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > maxBytes
    || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AuditLogCursorInvalidError("audit-log cursor is blank, malformed, or oversized");
  }
  let value: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical base64url");
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new AuditLogCursorInvalidError("audit-log cursor is malformed", { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 13 || value[0] !== 1 || value[1] !== "an"
    || !IO.integrityTag(value[2]) || !IO.positiveInteger(value[3]) || !IO.positiveInteger(value[4])
    || !IO.positiveInteger(value[5]) || !IO.integrityTag(value[6])
    || (value[7] !== "o" && value[7] !== "n") || !IO.positiveInteger(value[8])
    || !IO.nonnegativeInteger(value[9]) || !IO.positiveInteger(value[10])
    || !IO.integrityTag(value[11])) {
    throw new AuditLogCursorInvalidError("audit-log cursor payload is invalid");
  }
  const types = value[12] === null ? [] : typesFromMask(value[12]);
  if (types === null) throw new AuditLogCursorInvalidError("audit-log cursor filter is invalid");
  return {
    kind: "navigation",
    id: value[2],
    generation: value[3] as number,
    highSequence: value[4] as number,
    highOffset: value[5] as number,
    prefixDigest: value[6],
    direction: value[7] === "o" ? "older" : "newer",
    boundarySequence: value[8] as number,
    boundaryStart: value[9] as number,
    boundaryEnd: value[10] as number,
    boundaryDigest: value[11] as string,
    types,
    filterProvided: value[12] !== null,
  };
}

function snapshotFrom(payload: NavigationPayload): SnapshotPayload {
  return {
    kind: "snapshot",
    id: payload.id,
    generation: payload.generation,
    highSequence: payload.highSequence,
    highOffset: payload.highOffset,
    prefixDigest: payload.prefixDigest,
  };
}

function validateSnapshot(payload: SnapshotPayload, header: AuditLogHeaderRecord, fileSize: number): void {
  if (payload.id !== identityTag(header.auditLogId) || payload.generation !== header.generation) {
    throw new AuditLogCursorInvalidError("audit-log cursor belongs to another log generation");
  }
  if (payload.highOffset > fileSize) throw new AuditLogCursorInvalidError("audit log was truncated after cursor creation");
}

function normalizeTypes(input: readonly AuditLogRecordType[] | undefined): TypeFilter {
  if (input === undefined) return Object.freeze({ provided: false, types: Object.freeze([]) });
  const unique = [...new Set(input)].sort();
  for (const type of unique) {
    if (!AUDIT_TYPES.has(type)) throw new AuditLogReaderError(`unknown audit-log record type: ${String(type)}`);
  }
  return Object.freeze({ provided: true, types: Object.freeze(unique) });
}

function validatedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AuditLogReaderError(`limit must be an integer from 1 through ${MAX_LIMIT}`);
  }
  return limit;
}

function identityTag(value: string): string {
  return IO.sha256Bytes(Buffer.from(value, "utf8"));
}

function typesMask(types: readonly AuditLogRecordType[]): number {
  let mask = 0;
  for (const type of types) mask |= 1 << AUDIT_TYPE_ORDER.indexOf(type);
  return mask;
}

function typesFromMask(value: unknown): AuditLogRecordType[] | null {
  if (!IO.nonnegativeInteger(value) || value >= (1 << AUDIT_TYPE_ORDER.length)) return null;
  return AUDIT_TYPE_ORDER.filter((_, index) => (value & (1 << index)) !== 0).sort();
}

function boundedNavigationCursor(value: string, header: AuditLogHeaderRecord): AuditLogCursor {
  if (Buffer.byteLength(value, "utf8") > header.effectiveLimits.maxCursorBytes) {
    throw new AuditLogReaderError("generated audit-log navigation cursor exceeds the engraved limit");
  }
  return value as AuditLogCursor;
}

function boundedSnapshotCursor(value: string, header: AuditLogHeaderRecord): AuditLogSnapshotCursor {
  if (Buffer.byteLength(value, "utf8") > header.effectiveLimits.maxCursorBytes) {
    throw new AuditLogReaderError("generated audit-log snapshot cursor exceeds the engraved limit");
  }
  return value as AuditLogSnapshotCursor;
}

function translateError(error: unknown): Error {
  if (error instanceof AuditLogReaderError || error instanceof AuditLogCursorInvalidError) return error;
  if (error instanceof TranscriptCursorInvalidError) {
    return new AuditLogCursorInvalidError(error.message, { cause: error });
  }
  if (error instanceof TranscriptReaderError) return new AuditLogReaderError(error.message, { cause: error });
  return new AuditLogReaderError("cannot read audit log", { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
