import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  parseLegacyTranscriptLine,
  type TranscriptLine as LegacyTranscriptLine,
  type TranscriptMessageLine as LegacyTranscriptMessageLine,
} from "../transcript.ts";
import { canonicalizeJson } from "./integrity.ts";
import type { JsonObject } from "./checkpoint.ts";
import {
  validateTranscriptRecord,
  type KnownTranscriptRecord,
  type TranscriptActivityRecord,
  type TranscriptConfigurationRecord,
  type TranscriptHeaderRecord,
  type TranscriptLifecycleRecord,
  type TranscriptMessageRecord,
  type TranscriptMeteringReferenceRecord,
  type TranscriptPermissionRecord,
  type TranscriptCancellationRecord,
  type TranscriptProtocolMetadataRecord,
  type TranscriptReasoningRecord,
  type TranscriptRecordType,
  type TranscriptTransitionRecord,
  type UnknownTranscriptRecord,
} from "./records.ts";
import {
  presentationItemFromRecord,
  type TranscriptPresentationItem,
  type TranscriptPresentationRecord,
} from "./presentation.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const READ_CHUNK_BYTES = 64 * 1024;
const HARD_MAX_RECORD_BYTES = 16_777_216;
const HARD_MAX_CURSOR_BYTES = 16_384;
const CURSOR_VERSION = 1;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const RECORD_TYPE_ORDER: readonly TranscriptRecordType[] = Object.freeze([
  "header", "checkpoint", "operation", "message", "reasoning", "activity",
  "configuration", "permission", "transition", "metering_reference", "lifecycle",
  "protocol", "raw", "cancellation",
]);
const RECORD_TYPES = new Set(RECORD_TYPE_ORDER);
const TIMELINE_TYPES = new Set<TranscriptRecordType>([
  "message", "reasoning", "activity", "configuration", "permission", "transition",
  "metering_reference", "lifecycle", "protocol", "cancellation",
]);

export type TranscriptView = "conversation" | "timeline" | "records";
export type TranscriptCursor = string & { readonly __transcriptCursor: unique symbol };
export type TranscriptSnapshotCursor = string & { readonly __transcriptSnapshotCursor: unique symbol };
export type TranscriptPresentationCursor = string & { readonly __transcriptPresentationCursor: unique symbol };

export interface ReadTranscriptPageOptions {
  readonly cursor?: TranscriptCursor;
  readonly limit?: number;
  readonly view?: TranscriptView;
  readonly types?: readonly TranscriptRecordType[];
}

export interface TranscriptPage<
  T,
  C = TranscriptCursor,
  S = TranscriptSnapshotCursor,
> {
  readonly items: readonly T[];
  readonly olderCursor: C | null;
  readonly newerCursor: C | null;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly snapshot: S;
}

export interface ReadTranscriptPresentationPageOptions {
  readonly cursor?: TranscriptPresentationCursor;
  readonly limit?: number;
}

export type TranscriptPresentationPage = TranscriptPage<
  TranscriptPresentationItem,
  TranscriptPresentationCursor,
  TranscriptSnapshotCursor
>;

export type TranscriptConversationItem = TranscriptMessageRecord | LegacyTranscriptMessageLine;
export type TranscriptTimelineItem =
  | TranscriptMessageRecord
  | TranscriptReasoningRecord
  | TranscriptActivityRecord
  | TranscriptConfigurationRecord
  | TranscriptPermissionRecord
  | TranscriptCancellationRecord
  | TranscriptTransitionRecord
  | TranscriptMeteringReferenceRecord
  | TranscriptLifecycleRecord
  | TranscriptProtocolMetadataRecord
  | LegacyTranscriptLine;

export type TranscriptReadableRecord =
  | KnownTranscriptRecord
  | UnknownTranscriptRecord
  | LegacyTranscriptLine;

export type ActivityExecutionState = "observed_live" | "historically_open" | "terminal";

export interface PersistedActivityState {
  readonly activityId: string;
  readonly activityRevision: number;
  readonly operationId: string;
  readonly reason: TranscriptActivityRecord["reason"];
  readonly kind: string;
  readonly status?: string;
  readonly data: JsonObject;
  readonly execution: ActivityExecutionState;
}

export interface ListTranscriptActivitiesOptions {
  readonly at?: TranscriptSnapshotCursor;
  readonly status?: "open" | "terminal" | "all";
  readonly limit?: number;
  readonly order?: "updated_desc" | "updated_asc";
}

export interface PersistedActivityStatePage {
  readonly activities: readonly PersistedActivityState[];
  readonly snapshot: TranscriptSnapshotCursor;
}

export class TranscriptCursorInvalidError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptCursorInvalidError";
  }
}

export class TranscriptReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptReaderError";
  }
}

interface SnapshotBoundary {
  readonly v: 1;
  readonly id: string;
  readonly generation: number;
  readonly highSequence: number;
  readonly highOffset: number;
  readonly prefixDigest: string;
}

interface SnapshotPayload extends SnapshotBoundary {
  readonly k: "transcript_snapshot";
}

interface NavigationPayload extends SnapshotBoundary {
  readonly k: "transcript_navigation";
  readonly direction: "older" | "newer";
  readonly boundarySequence: number;
  readonly boundaryStart: number;
  readonly boundaryEnd: number;
  readonly boundaryDigest: string;
  readonly view: TranscriptView;
  readonly types: readonly TranscriptRecordType[];
  readonly filterProvided: boolean;
}

interface PresentationNavigationPayload extends SnapshotBoundary {
  readonly k: "transcript_presentation";
  readonly direction: "older" | "newer";
  readonly boundaryPosition: number;
  readonly boundaryId: string;
}

interface PhysicalRecord<T = TranscriptReadableRecord> {
  readonly item: T;
  readonly sequence: number;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
}

interface SnapshotContext {
  readonly handle: FileHandle;
  readonly header: TranscriptHeaderRecord;
  readonly payload: SnapshotPayload;
  readonly snapshotCursor: TranscriptSnapshotCursor;
  readonly navigation: NavigationPayload | null;
}

/** Snapshot-bound, cursor-paginated reader for one v2 transcript generation. */
export class TranscriptReader {
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new TranscriptReaderError("transcript reader path must be absolute");
  }

  readPage(options?: ReadTranscriptPageOptions & { readonly view?: "timeline" }): Promise<TranscriptPage<TranscriptTimelineItem>>;
  readPage(options: ReadTranscriptPageOptions & { readonly view: "conversation" }): Promise<TranscriptPage<TranscriptConversationItem>>;
  readPage(options: ReadTranscriptPageOptions & { readonly view: "records" }): Promise<TranscriptPage<TranscriptReadableRecord>>;
  async readPage(
    options: ReadTranscriptPageOptions = {},
  ): Promise<TranscriptPage<TranscriptReadableRecord>> {
    const limit = validatedLimit(options.limit);
    const view = options.view ?? "timeline";
    const filter = normalizeTypes(view, options.types);
    const snapshot = await this.openSnapshot(options.cursor, "navigation");
    try {
      const navigation = snapshot.navigation;
      if (navigation) {
        if (navigation.view !== view || navigation.filterProvided !== filter.provided
          || canonicalizeJson(navigation.types) !== canonicalizeJson(filter.types)) {
          throw new TranscriptCursorInvalidError("transcript cursor view or type filter changed");
        }
        await validateBoundary(snapshot.handle, snapshot.header, navigation);
      }

      let selected: PhysicalRecord[];
      let hasOlder: boolean;
      let hasNewer: boolean;
      if (!navigation || navigation.direction === "older") {
        const end = navigation?.boundaryStart ?? snapshot.payload.highOffset;
        const matches = await collectBackward(
          snapshot.handle,
          snapshot.header,
          end,
          limit + 1,
          navigation ? navigation.boundarySequence - 1 : snapshot.payload.highSequence,
          (record) => projectRecord(record.item, view, filter),
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
          navigation.boundaryStart < legacyBoundary(snapshot.header)
            ? 1
            : navigation.boundarySequence + 1,
          (record) => projectRecord(record.item, view, filter),
        );
        hasOlder = true;
        hasNewer = matches.length > limit;
        selected = matches.slice(0, limit);
      }

      const first = selected[0];
      const last = selected.at(-1);
      return Object.freeze({
        items: Object.freeze(selected.map((record) => structuredClone(record.item))),
        olderCursor: hasOlder && first
          ? boundedCursor(
              encodeNavigation(snapshot.payload, "older", first, view, filter),
              snapshot.header.effectiveLimits.maxCursorBytes,
            )
          : null,
        newerCursor: hasNewer && last
          ? boundedCursor(
              encodeNavigation(snapshot.payload, "newer", last, view, filter),
              snapshot.header.effectiveLimits.maxCursorBytes,
            )
          : null,
        hasOlder,
        hasNewer,
        snapshot: snapshot.snapshotCursor,
      });
    } finally {
      await snapshot.handle.close().catch(() => undefined);
    }
  }

  /**
   * Read logical display items in their first-observed order. Revisions are folded by
   * stable item id; a later activity/message revision never moves the original item.
   * Legacy records and v2 records without presentation metadata are intentionally absent.
   */
  async readPresentationPage(
    options: ReadTranscriptPresentationPageOptions = {},
  ): Promise<TranscriptPresentationPage> {
    const limit = validatedLimit(options.limit);
    const navigation = options.cursor === undefined
      ? null
      : decodePresentationCursor(options.cursor, HARD_MAX_CURSOR_BYTES);
    const snapshot = navigation
      ? await this.openSnapshot(
          encodeCursor(snapshotPayloadFrom(navigation)) as TranscriptSnapshotCursor,
          "snapshot",
        )
      : await this.openSnapshot(undefined, "navigation");
    try {
      if (options.cursor !== undefined
        && Buffer.byteLength(options.cursor, "utf8") > snapshot.header.effectiveLimits.maxCursorBytes) {
        throw new TranscriptCursorInvalidError("presentation cursor exceeds the transcript's engraved limit");
      }
      if (navigation && (navigation.id !== snapshot.payload.id
        || navigation.generation !== snapshot.payload.generation
        || navigation.highSequence !== snapshot.payload.highSequence
        || navigation.highOffset !== snapshot.payload.highOffset
        || navigation.prefixDigest !== snapshot.payload.prefixDigest)) {
        throw new TranscriptCursorInvalidError("presentation cursor snapshot changed");
      }

      // Keep only this page plus one look-ahead item. Every first revision has
      // position === physical seq, so candidates can be selected while scanning and
      // later revisions can update only the bounded candidate set.
      const latest = new Map<string, TranscriptPresentationRecord>();
      const startedAt = new Map<string, number>();
      const candidateIds: string[] = [];
      let boundaryFound = navigation === null;
      let expectedSequence = 1;
      for await (const physical of forwardLines(
        snapshot.handle,
        legacyBoundary(snapshot.header),
        snapshot.payload.highOffset,
        snapshot.header.effectiveLimits.maxRecordBytes,
      )) {
        const parsed = parsePhysical(physical, snapshot.header);
        if (!parsed) continue;
        if (parsed.sequence !== expectedSequence) {
          throw new TranscriptReaderError("transcript sequence is not physically contiguous");
        }
        expectedSequence++;
        if (!isPresentationRecord(parsed.item) || !parsed.item.presentation) continue;

        const record = parsed.item;
        const metadata = record.presentation!;
        const previous = latest.get(metadata.id);
        if (previous) {
          validatePresentationRevision(previous, record);
          latest.set(metadata.id, record);
          continue;
        }
        if (metadata.position !== record.seq) {
          // A revision for an item outside this bounded page needs no retained state.
          continue;
        }
        if (navigation && metadata.position === navigation.boundaryPosition) {
          if (identityTag(metadata.id) !== navigation.boundaryId) {
            throw new TranscriptCursorInvalidError("presentation cursor boundary changed");
          }
          boundaryFound = true;
        }
        const eligible = !navigation
          || (navigation.direction === "older"
            ? metadata.position < navigation.boundaryPosition
            : metadata.position > navigation.boundaryPosition);
        if (!eligible) continue;
        latest.set(metadata.id, record);
        startedAt.set(metadata.id, record.ts);
        candidateIds.push(metadata.id);
        if (candidateIds.length > limit + 1) {
          const removeIndex = navigation?.direction === "newer"
            ? candidateIds.length - 1
            : 0;
          const [removed] = candidateIds.splice(removeIndex, 1);
          if (removed) {
            latest.delete(removed);
            startedAt.delete(removed);
          }
        }
      }
      if (!boundaryFound) {
        throw new TranscriptCursorInvalidError("presentation cursor boundary is absent from its snapshot");
      }

      const hasExtra = candidateIds.length > limit;
      const pageIds = navigation?.direction === "newer"
        ? candidateIds.slice(0, limit)
        : candidateIds.slice(Math.max(0, candidateIds.length - limit));
      const selected = pageIds.map((id) => presentationItemFromRecord(latest.get(id)!, startedAt.get(id))!);
      const hasOlder = navigation?.direction === "newer" ? true : hasExtra;
      const hasNewer = navigation?.direction === "older" ? true : navigation?.direction === "newer" ? hasExtra : false;
      const first = selected[0];
      const last = selected.at(-1);
      return Object.freeze({
        items: Object.freeze(selected.map((item) => structuredClone(item))),
        olderCursor: hasOlder && first
          ? boundedPresentationCursor(
              encodePresentationCursor(snapshot.payload, "older", first),
              snapshot.header.effectiveLimits.maxCursorBytes,
            )
          : null,
        newerCursor: hasNewer && last
          ? boundedPresentationCursor(
              encodePresentationCursor(snapshot.payload, "newer", last),
              snapshot.header.effectiveLimits.maxCursorBytes,
            )
          : null,
        hasOlder,
        hasNewer,
        snapshot: snapshot.snapshotCursor,
      });
    } finally {
      await snapshot.handle.close().catch(() => undefined);
    }
  }

  async listActivityStates(
    options: ListTranscriptActivitiesOptions = {},
  ): Promise<PersistedActivityStatePage> {
    const limit = validatedLimit(options.limit);
    const status = options.status ?? "all";
    if (status !== "all" && status !== "open" && status !== "terminal") {
      throw new TranscriptReaderError(`invalid activity status filter: ${String(status)}`);
    }
    const order = options.order ?? "updated_desc";
    if (order !== "updated_desc" && order !== "updated_asc") {
      throw new TranscriptReaderError(`invalid activity order: ${String(order)}`);
    }
    const snapshot = await this.openSnapshot(options.at, "snapshot");
    try {
      const latest = new Map<string, { record: TranscriptActivityRecord; sequence: number }>();
      for await (const physical of forwardLines(snapshot.handle, 0, snapshot.payload.highOffset, snapshot.header.effectiveLimits.maxRecordBytes)) {
        const parsed = parsePhysical(physical, snapshot.header);
        if (!parsed) continue;
        if (!isActivityRecord(parsed.item)) continue;
        const previous = latest.get(parsed.item.activityId);
        if (previous && parsed.item.activityRevision <= previous.record.activityRevision) {
          throw new TranscriptReaderError(`activity revisions are not increasing for ${parsed.item.activityId}`);
        }
        latest.set(parsed.item.activityId, { record: parsed.item, sequence: parsed.sequence });
      }
      const folded = [...latest.values()].map(({ record, sequence }) => ({
        state: activityState(record),
        sequence,
      })).filter(({ state }) => status === "all"
        || (status === "terminal" ? state.execution === "terminal" : state.execution !== "terminal"));
      folded.sort((left, right) => {
        const bySequence = left.sequence - right.sequence;
        const deterministic = bySequence || left.state.activityId.localeCompare(right.state.activityId);
        return order === "updated_asc" ? deterministic : -deterministic;
      });
      return Object.freeze({
        activities: Object.freeze(folded.slice(0, limit).map(({ state }) => Object.freeze(state))),
        snapshot: snapshot.snapshotCursor,
      });
    } finally {
      await snapshot.handle.close().catch(() => undefined);
    }
  }

  private async openSnapshot(
    cursor: TranscriptCursor | TranscriptSnapshotCursor | undefined,
    expected: "navigation" | "snapshot",
  ): Promise<SnapshotContext> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      throw new TranscriptReaderError(`cannot open transcript: ${this.path}`, { cause: error });
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new TranscriptReaderError("transcript reader target is not a regular file");
      const header = await readHeader(handle, stat.size);
      let payload: SnapshotPayload;
      let navigation: NavigationPayload | null = null;
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor, header.effectiveLimits.maxCursorBytes);
        if (expected === "snapshot" && decoded.k !== "transcript_snapshot") {
          throw new TranscriptCursorInvalidError("activity state requires a transcript snapshot cursor");
        }
        if (expected === "navigation" && decoded.k !== "transcript_navigation") {
          throw new TranscriptCursorInvalidError("readPage requires a transcript navigation cursor");
        }
        payload = snapshotPayloadFrom(decoded);
        navigation = decoded.k === "transcript_navigation" ? decoded : null;
        validateSnapshotPayload(payload, header, stat.size);
        const digest = await digestPrefix(handle, payload.highOffset);
        if (digest !== payload.prefixDigest) {
          throw new TranscriptCursorInvalidError("transcript content changed before the cursor snapshot boundary");
        }
        await validateHighBoundary(handle, header, payload);
      } else {
        const highOffset = await lastCompleteOffset(handle, stat.size);
        if (highOffset === 0) throw new TranscriptReaderError("transcript has no complete records");
        const high = await readLastPhysical(handle, highOffset, header.effectiveLimits.maxRecordBytes);
        const parsedHigh = parsePhysical(high, header);
        if (!parsedHigh || parsedHigh.item.v !== 2) {
          throw new TranscriptReaderError("transcript snapshot has no v2 high-water record");
        }
        payload = {
          v: CURSOR_VERSION,
          k: "transcript_snapshot",
          id: identityTag(header.transcriptId),
          generation: header.generation,
          highSequence: parsedHigh.sequence,
          highOffset,
          prefixDigest: await digestPrefix(handle, highOffset),
        };
      }
      const snapshotPayload = snapshotPayloadFrom(payload);
      return {
        handle,
        header,
        payload: snapshotPayload,
        snapshotCursor: boundedSnapshotCursor(
          encodeCursor(snapshotPayload),
          header.effectiveLimits.maxCursorBytes,
        ),
        navigation,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (error instanceof TranscriptReaderError || error instanceof TranscriptCursorInvalidError) throw error;
      throw new TranscriptReaderError("cannot read transcript snapshot", { cause: error });
    }
  }
}

function projectRecord(
  record: TranscriptReadableRecord,
  view: TranscriptView,
  filter: TypeFilter,
): boolean {
  if (view === "conversation") return record.t === "message" || record.t === "msg";
  const type = "transcriptId" in record
    ? record.t as TranscriptRecordType
    : legacyProjectionType(record);
  if (view === "timeline") return type !== null && TIMELINE_TYPES.has(type)
    && (!filter.provided || filter.types.includes(type));
  return !filter.provided || (type !== null && filter.types.includes(type));
}

interface TypeFilter {
  readonly provided: boolean;
  readonly types: readonly TranscriptRecordType[];
}

function normalizeTypes(
  view: TranscriptView,
  input: readonly TranscriptRecordType[] | undefined,
): TypeFilter {
  if (view !== "conversation" && view !== "timeline" && view !== "records") {
    throw new TranscriptReaderError(`invalid transcript view: ${String(view)}`);
  }
  if (view === "conversation") {
    if (input !== undefined) throw new TranscriptReaderError("conversation view does not accept a type filter");
    return Object.freeze({ provided: false, types: Object.freeze([]) });
  }
  if (input === undefined) return Object.freeze({ provided: false, types: Object.freeze([]) });
  const unique = [...new Set(input)].sort();
  for (const type of unique) {
    if (!RECORD_TYPES.has(type)) throw new TranscriptReaderError(`unknown transcript record type: ${String(type)}`);
    if (view === "timeline" && !TIMELINE_TYPES.has(type)) {
      throw new TranscriptReaderError(`record type ${type} is not part of the timeline view`);
    }
  }
  return Object.freeze({ provided: true, types: Object.freeze(unique) });
}

function validatedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TranscriptReaderError(`limit must be an integer from 1 through ${MAX_LIMIT}`);
  }
  return limit;
}

function activityState(record: TranscriptActivityRecord): PersistedActivityState {
  return {
    activityId: record.activityId,
    activityRevision: record.activityRevision,
    operationId: record.operationId,
    reason: record.reason,
    kind: record.kind,
    ...(record.status === undefined ? {} : { status: record.status }),
    data: structuredClone(record.data) as JsonObject,
    execution: record.reason === "settled" ? "terminal" : "historically_open",
  };
}

async function collectBackward(
  handle: FileHandle,
  header: TranscriptHeaderRecord,
  end: number,
  count: number,
  expectedFirstSequence: number,
  match: (record: PhysicalRecord) => boolean,
): Promise<PhysicalRecord[]> {
  const output: PhysicalRecord[] = [];
  let expectedSequence = expectedFirstSequence;
  for await (const physical of backwardLines(handle, end, header.effectiveLimits.maxRecordBytes)) {
    const parsed = parsePhysical(physical, header);
    if (!parsed) continue;
    if (parsed.item.v === 2) {
      if (parsed.sequence !== expectedSequence) throw new TranscriptReaderError("transcript sequence is not physically contiguous");
      expectedSequence--;
    }
    if (match(parsed)) output.push(parsed);
    if (output.length >= count) break;
  }
  return output;
}

async function collectForward(
  handle: FileHandle,
  header: TranscriptHeaderRecord,
  start: number,
  end: number,
  count: number,
  expectedFirstSequence: number,
  match: (record: PhysicalRecord) => boolean,
): Promise<PhysicalRecord[]> {
  const output: PhysicalRecord[] = [];
  let expectedSequence = expectedFirstSequence;
  for await (const physical of forwardLines(handle, start, end, header.effectiveLimits.maxRecordBytes)) {
    const parsed = parsePhysical(physical, header);
    if (!parsed) continue;
    if (parsed.item.v === 2) {
      if (parsed.sequence !== expectedSequence) throw new TranscriptReaderError("transcript sequence is not physically contiguous");
      expectedSequence++;
    }
    if (match(parsed)) output.push(parsed);
    if (output.length >= count) break;
  }
  return output;
}

export interface SessionLogPhysicalLine {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
}

type PhysicalLine = SessionLogPhysicalLine;

async function* forwardLines(
  handle: FileHandle,
  startOffset: number,
  endOffset: number,
  maxRecordBytes: number,
): AsyncGenerator<PhysicalLine> {
  let position = startOffset;
  let pending = Buffer.alloc(0);
  let pendingStart = startOffset;
  while (position < endOffset) {
    const size = Math.min(READ_CHUNK_BYTES, endOffset - position);
    const block = await readBytes(handle, position, size);
    if (block.byteLength !== size) throw new TranscriptReaderError("transcript changed while reading snapshot");
    position += size;
    const combined = pending.byteLength === 0 ? Buffer.from(block) : Buffer.concat([pending, block]);
    let cursor = 0;
    for (;;) {
      const lf = combined.indexOf(0x0a, cursor);
      if (lf < 0) break;
      const bytes = combined.subarray(cursor, lf);
      if (bytes.byteLength > maxRecordBytes) throw new TranscriptReaderError("transcript record exceeds engraved limit");
      const start = pendingStart + cursor;
      yield { bytes, start, end: pendingStart + lf + 1 };
      cursor = lf + 1;
    }
    pending = Buffer.from(combined.subarray(cursor));
    pendingStart += cursor;
    if (pending.byteLength > Math.min(maxRecordBytes, HARD_MAX_RECORD_BYTES)) {
      throw new TranscriptReaderError("transcript record exceeds reader safety ceiling");
    }
  }
  if (pending.byteLength !== 0) throw new TranscriptReaderError("snapshot boundary does not end at a complete record");
}

async function* backwardLines(
  handle: FileHandle,
  endOffset: number,
  maxRecordBytes: number,
): AsyncGenerator<PhysicalLine> {
  let position = endOffset;
  let carry = Buffer.alloc(0);
  while (position > 0) {
    const start = Math.max(0, position - READ_CHUNK_BYTES);
    const block = await readBytes(handle, start, position - start);
    if (block.byteLength !== position - start) throw new TranscriptReaderError("transcript changed while reading snapshot");
    const combined = carry.byteLength === 0 ? Buffer.from(block) : Buffer.concat([block, carry]);
    const lineFeeds: number[] = [];
    for (let at = combined.indexOf(0x0a); at >= 0; at = combined.indexOf(0x0a, at + 1)) lineFeeds.push(at);
    for (let index = lineFeeds.length - 1; index >= 1; index--) {
      const lineStart = lineFeeds[index - 1]! + 1;
      const lineEnd = lineFeeds[index]!;
      const bytes = combined.subarray(lineStart, lineEnd);
      if (bytes.byteLength > maxRecordBytes) throw new TranscriptReaderError("transcript record exceeds engraved limit");
      yield { bytes, start: start + lineStart, end: start + lineEnd + 1 };
    }
    if (start === 0 && lineFeeds.length > 0) {
      const lineEnd = lineFeeds[0]!;
      const bytes = combined.subarray(0, lineEnd);
      if (bytes.byteLength > maxRecordBytes) throw new TranscriptReaderError("transcript record exceeds engraved limit");
      yield { bytes, start: 0, end: lineEnd + 1 };
      return;
    }
    carry = lineFeeds.length > 0
      ? Buffer.from(combined.subarray(0, lineFeeds[0]! + 1))
      : combined;
    if (carry.byteLength > Math.min(maxRecordBytes, HARD_MAX_RECORD_BYTES) + 1) {
      throw new TranscriptReaderError("transcript record exceeds reader safety ceiling");
    }
    position = start;
  }
}

function parsePhysical(
  physical: PhysicalLine,
  header: TranscriptHeaderRecord,
): PhysicalRecord | null {
  if (physical.bytes.byteLength === 0) throw new TranscriptReaderError("transcript contains an empty record");
  if (physical.start < legacyBoundary(header)) {
    let raw: string;
    try {
      raw = UTF8.decode(physical.bytes);
    } catch {
      return null;
    }
    const item = parseLegacyTranscriptLine(raw);
    return item ? {
      item,
      sequence: physical.start + 1,
      start: physical.start,
      end: physical.end,
      digest: sha256Bytes(physical.bytes),
    } : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(physical.bytes));
  } catch (error) {
    throw new TranscriptReaderError("transcript contains malformed UTF-8 or JSON", { cause: error });
  }
  if (!isRecord(value)) throw new TranscriptReaderError("transcript record must be an object");
  const commonValid = value.v === 2
    && typeof value.t === "string" && value.t.length > 0
    && value.transcriptId === header.transcriptId
    && value.generation === header.generation
    && value.agentSessionId === header.agentSessionId
    && Number.isSafeInteger(value.seq) && (value.seq as number) > 0
    && Number.isSafeInteger(value.ts);
  if (!commonValid) throw new TranscriptReaderError("transcript record envelope is invalid or changes identity");
  let item: KnownTranscriptRecord | UnknownTranscriptRecord;
  if (RECORD_TYPES.has(value.t as TranscriptRecordType)) {
    try {
      validateTranscriptRecord(value, {
        agentSessionId: header.agentSessionId,
        logId: header.transcriptId,
        generation: header.generation,
      });
    } catch (error) {
      throw new TranscriptReaderError(`invalid transcript record at sequence ${String(value.seq)}`, { cause: error });
    }
    item = value;
  } else {
    try {
      canonicalizeJson(value);
    } catch (error) {
      throw new TranscriptReaderError("unknown transcript record is not canonical JSON", { cause: error });
    }
    item = {
      v: value.v as number,
      t: value.t as string,
      transcriptId: value.transcriptId as string,
      generation: value.generation as number,
      agentSessionId: value.agentSessionId as string,
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
    digest: sha256Bytes(physical.bytes),
  };
}

async function readHeader(handle: FileHandle, fileSize: number): Promise<TranscriptHeaderRecord> {
  if (fileSize === 0) throw new TranscriptReaderError("transcript is empty");
  const completeOffset = await lastCompleteOffset(handle, fileSize);
  for await (const physical of forwardLines(handle, 0, completeOffset, HARD_MAX_RECORD_BYTES)) {
    let value: unknown;
    try {
      value = JSON.parse(UTF8.decode(physical.bytes));
    } catch {
      continue;
    }
    if (!isRecord(value) || value.v !== 2) continue;
    try {
      validateTranscriptRecord(value);
    } catch (error) {
      throw new TranscriptReaderError("transcript v2 header is invalid", { cause: error });
    }
    if (value.t !== "header" || value.seq !== 1) {
      throw new TranscriptReaderError("first v2 transcript record is not its header");
    }
    if (physical.start > 0 && (value.event !== "upgraded"
      || value.upgradedFrom?.boundaryOffset !== physical.start)) {
      throw new TranscriptReaderError("mixed transcript legacy boundary is invalid");
    }
    return value;
  }
  throw new TranscriptReaderError("transcript has no complete v2 header");
}

async function firstPhysical(handle: FileHandle, fileSize: number): Promise<PhysicalLine> {
  let position = 0;
  let bytes = Buffer.alloc(0);
  while (position < fileSize && bytes.byteLength <= HARD_MAX_RECORD_BYTES) {
    const size = Math.min(READ_CHUNK_BYTES, fileSize - position);
    const block = await readBytes(handle, position, size);
    if (block.byteLength === 0) throw new TranscriptReaderError("transcript changed while reading its header");
    const combined = bytes.byteLength === 0 ? Buffer.from(block) : Buffer.concat([bytes, block]);
    const lf = combined.indexOf(0x0a);
    if (lf >= 0) return { bytes: combined.subarray(0, lf), start: 0, end: lf + 1 };
    bytes = combined;
    position += block.byteLength;
  }
  throw new TranscriptReaderError("transcript has no bounded complete header");
}

async function readLastPhysical(handle: FileHandle, highOffset: number, maxRecordBytes: number): Promise<PhysicalLine> {
  for await (const physical of backwardLines(handle, highOffset, maxRecordBytes)) return physical;
  throw new TranscriptReaderError("transcript has no complete record at its snapshot boundary");
}

async function lastCompleteOffset(handle: FileHandle, fileSize: number): Promise<number> {
  let position = fileSize;
  let suffixBytes = 0;
  while (position > 0) {
    const start = Math.max(0, position - READ_CHUNK_BYTES);
    const block = await readBytes(handle, start, position - start);
    for (let index = block.byteLength - 1; index >= 0; index--) {
      if (block[index] === 0x0a) return start + index + 1;
    }
    suffixBytes += block.byteLength;
    if (suffixBytes > HARD_MAX_RECORD_BYTES) {
      throw new TranscriptReaderError("incomplete transcript suffix exceeds reader safety ceiling");
    }
    position = start;
  }
  return 0;
}

async function validateBoundary(
  handle: FileHandle,
  header: TranscriptHeaderRecord,
  cursor: NavigationPayload,
): Promise<void> {
  if (cursor.boundaryStart < 0 || cursor.boundaryEnd <= cursor.boundaryStart
    || cursor.boundaryEnd > cursor.highOffset) {
    throw new TranscriptCursorInvalidError("transcript cursor boundary offsets are invalid");
  }
  const bytes = await readBytes(handle, cursor.boundaryStart, cursor.boundaryEnd - cursor.boundaryStart);
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new TranscriptCursorInvalidError("transcript cursor boundary is no longer a complete record");
  }
  const physical = { bytes: bytes.subarray(0, bytes.byteLength - 1), start: cursor.boundaryStart, end: cursor.boundaryEnd };
  let parsed: PhysicalRecord;
  try {
    const candidate = parsePhysical(physical, header);
    if (!candidate) throw new Error("unreadable boundary");
    parsed = candidate;
  } catch (error) {
    throw new TranscriptCursorInvalidError("transcript cursor boundary is invalid", { cause: error });
  }
  if (parsed.sequence !== cursor.boundarySequence || parsed.digest !== cursor.boundaryDigest) {
    throw new TranscriptCursorInvalidError("transcript cursor boundary changed");
  }
}

async function validateHighBoundary(
  handle: FileHandle,
  header: TranscriptHeaderRecord,
  cursor: SnapshotPayload,
): Promise<void> {
  let physical: PhysicalLine;
  let parsed: PhysicalRecord;
  try {
    physical = await readLastPhysical(handle, cursor.highOffset, header.effectiveLimits.maxRecordBytes);
    const candidate = parsePhysical(physical, header);
    if (!candidate) throw new Error("unreadable high-water boundary");
    parsed = candidate;
  } catch (error) {
    throw new TranscriptCursorInvalidError("transcript cursor high-water boundary is invalid", { cause: error });
  }
  if (parsed.sequence !== cursor.highSequence || physical.end !== cursor.highOffset) {
    throw new TranscriptCursorInvalidError("transcript cursor high-water boundary changed");
  }
}

function encodeNavigation(
  snapshot: SnapshotPayload,
  direction: "older" | "newer",
  boundary: PhysicalRecord,
  view: TranscriptView,
  filter: TypeFilter,
): TranscriptCursor {
  return encodeCursor({
    ...snapshot,
    k: "transcript_navigation",
    direction,
    boundarySequence: boundary.sequence,
    boundaryStart: boundary.start,
    boundaryEnd: boundary.end,
    boundaryDigest: boundary.digest,
    view,
    types: filter.types,
    filterProvided: filter.provided,
  }) as TranscriptCursor;
}

function encodePresentationCursor(
  snapshot: SnapshotPayload,
  direction: "older" | "newer",
  boundary: TranscriptPresentationItem,
): TranscriptPresentationCursor {
  const wire = [
    1, "p", snapshot.id, snapshot.generation, snapshot.highSequence,
    snapshot.highOffset, snapshot.prefixDigest,
    direction === "older" ? "o" : "n", boundary.position, identityTag(boundary.id),
  ];
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url") as TranscriptPresentationCursor;
}

function decodePresentationCursor(
  cursor: string,
  maxBytes: number,
): PresentationNavigationPayload {
  if (typeof cursor !== "string" || cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > maxBytes) {
    throw new TranscriptCursorInvalidError("presentation cursor is blank or exceeds its limit");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new TranscriptCursorInvalidError("presentation cursor is not canonical base64url");
  }
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical base64url");
    value = JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    throw new TranscriptCursorInvalidError("presentation cursor is malformed", { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 10
    || value[0] !== CURSOR_VERSION || value[1] !== "p"
    || !integrityTag(value[2]) || !positiveInteger(value[3])
    || !positiveInteger(value[4]) || !positiveInteger(value[5])
    || !integrityTag(value[6]) || (value[7] !== "o" && value[7] !== "n")
    || !positiveInteger(value[8]) || !integrityTag(value[9])) {
    throw new TranscriptCursorInvalidError("presentation cursor payload is invalid");
  }
  return {
    v: 1,
    k: "transcript_presentation",
    id: value[2],
    generation: value[3] as number,
    highSequence: value[4] as number,
    highOffset: value[5] as number,
    prefixDigest: value[6],
    direction: value[7] === "o" ? "older" : "newer",
    boundaryPosition: value[8] as number,
    boundaryId: value[9] as string,
  };
}

function snapshotPayloadFrom(payload: SnapshotBoundary): SnapshotPayload {
  return {
    v: CURSOR_VERSION,
    k: "transcript_snapshot",
    id: payload.id,
    generation: payload.generation,
    highSequence: payload.highSequence,
    highOffset: payload.highOffset,
    prefixDigest: payload.prefixDigest,
  };
}

function encodeCursor(payload: SnapshotPayload | NavigationPayload): string {
  const wire = payload.k === "transcript_snapshot"
    ? [1, "s", payload.id, payload.generation, payload.highSequence, payload.highOffset, payload.prefixDigest]
    : [
        1, "n", payload.id, payload.generation, payload.highSequence, payload.highOffset,
        payload.prefixDigest, payload.direction === "older" ? "o" : "n",
        payload.boundarySequence, payload.boundaryStart, payload.boundaryEnd,
        payload.boundaryDigest, viewCode(payload.view), payload.filterProvided ? typesMask(payload.types) : null,
      ];
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, maxBytes: number): SnapshotPayload | NavigationPayload {
  if (typeof cursor !== "string" || cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > maxBytes) {
    throw new TranscriptCursorInvalidError("transcript cursor is blank or exceeds its engraved limit");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new TranscriptCursorInvalidError("transcript cursor is not canonical base64url");
  }
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical base64url");
    value = JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    throw new TranscriptCursorInvalidError("transcript cursor is malformed", { cause: error });
  }
  if (!Array.isArray(value) || (value.length !== 7 && value.length !== 14)
    || value[0] !== CURSOR_VERSION || (value[1] !== "s" && value[1] !== "n")
    || !integrityTag(value[2])
    || !positiveInteger(value[3]) || !positiveInteger(value[4])
    || !positiveInteger(value[5]) || !integrityTag(value[6])) {
    throw new TranscriptCursorInvalidError("transcript cursor payload is invalid");
  }
  if (value[1] === "s") {
    return {
      v: 1,
      k: "transcript_snapshot",
      id: value[2],
      generation: value[3] as number,
      highSequence: value[4] as number,
      highOffset: value[5] as number,
      prefixDigest: value[6],
    };
  }
  const types = value[13] === null ? [] : typesFromMask(value[13]);
  const view = decodeView(value[12]);
  if ((value[7] !== "o" && value[7] !== "n")
      || !positiveInteger(value[8])
      || !nonnegativeInteger(value[9])
      || !positiveInteger(value[10])
      || !integrityTag(value[11])
      || view === null
      || types === null) {
      throw new TranscriptCursorInvalidError("transcript navigation cursor payload is invalid");
  }
  {
    if ((view === "timeline" && types.some((type) => !TIMELINE_TYPES.has(type)))
      || (view === "conversation" && value[13] !== null)) {
      throw new TranscriptCursorInvalidError("transcript navigation cursor filter is invalid");
    }
  }
  return {
    v: 1,
    k: "transcript_navigation",
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
    view,
    types,
    filterProvided: value[13] !== null,
  };
}

function validateSnapshotPayload(payload: SnapshotPayload, header: TranscriptHeaderRecord, fileSize: number): void {
  if (payload.id !== identityTag(header.transcriptId) || payload.generation !== header.generation) {
    throw new TranscriptCursorInvalidError("transcript cursor belongs to another log generation");
  }
  if (payload.highOffset > fileSize) throw new TranscriptCursorInvalidError("transcript was truncated after cursor creation");
}

async function digestPrefix(handle: FileHandle, end: number): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < end) {
    const size = Math.min(READ_CHUNK_BYTES, end - position);
    const bytes = await readBytes(handle, position, size);
    if (bytes.byteLength !== size) throw new TranscriptCursorInvalidError("transcript changed while validating snapshot");
    hash.update(bytes);
    position += size;
  }
  return hash.digest("base64url").slice(0, 22);
}

async function readBytes(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(output, read, length - read, start + read);
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return read === length ? output : output.subarray(0, read);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

function identityTag(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function typesMask(types: readonly TranscriptRecordType[]): number {
  let mask = 0;
  for (const type of types) mask |= 1 << RECORD_TYPE_ORDER.indexOf(type);
  return mask;
}

function typesFromMask(value: unknown): TranscriptRecordType[] | null {
  if (!nonnegativeInteger(value) || value >= (1 << RECORD_TYPE_ORDER.length)) return null;
  return RECORD_TYPE_ORDER.filter((_, index) => (value & (1 << index)) !== 0).sort();
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function integrityTag(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
}

function viewCode(view: TranscriptView): "c" | "t" | "r" {
  return view === "conversation" ? "c" : view === "timeline" ? "t" : "r";
}

function decodeView(value: unknown): TranscriptView | null {
  return value === "c" ? "conversation" : value === "t" ? "timeline" : value === "r" ? "records" : null;
}

function boundedCursor(cursor: TranscriptCursor, maxBytes: number): TranscriptCursor {
  if (Buffer.byteLength(cursor, "utf8") > maxBytes) {
    throw new TranscriptReaderError("generated transcript navigation cursor exceeds the engraved limit");
  }
  return cursor;
}

function boundedPresentationCursor(
  cursor: TranscriptPresentationCursor,
  maxBytes: number,
): TranscriptPresentationCursor {
  if (Buffer.byteLength(cursor, "utf8") > maxBytes) {
    throw new TranscriptReaderError("generated transcript presentation cursor exceeds the engraved limit");
  }
  return cursor;
}

function boundedSnapshotCursor(cursor: string, maxBytes: number): TranscriptSnapshotCursor {
  if (Buffer.byteLength(cursor, "utf8") > maxBytes) {
    throw new TranscriptReaderError("generated transcript snapshot cursor exceeds the engraved limit");
  }
  return cursor as TranscriptSnapshotCursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityRecord(
  value: TranscriptReadableRecord,
): value is TranscriptActivityRecord {
  return "transcriptId" in value && value.v === 2
    && value.t === "activity" && "activityId" in value;
}

function isPresentationRecord(
  value: TranscriptReadableRecord,
): value is TranscriptPresentationRecord {
  return "transcriptId" in value && value.v === 2
    && (value.t === "message" || value.t === "reasoning" || value.t === "activity");
}

function validatePresentationRevision(
  previous: TranscriptPresentationRecord,
  record: TranscriptPresentationRecord,
): void {
  const metadata = record.presentation!;
  if (previous.t !== record.t
    || previous.operationId !== record.operationId
    || previous.presentation!.position !== metadata.position
    || previous.presentation!.revision >= metadata.revision) {
    throw new TranscriptReaderError(`invalid presentation revision for ${metadata.id}`);
  }
  if (previous.t === "message" && record.t === "message" && previous.role !== record.role) {
    throw new TranscriptReaderError(`presentation message role changed for ${metadata.id}`);
  }
}

function legacyBoundary(header: TranscriptHeaderRecord): number {
  return header.event === "upgraded" ? header.upgradedFrom!.boundaryOffset : 0;
}

function legacyProjectionType(record: LegacyTranscriptLine): TranscriptRecordType | null {
  switch (record.t) {
    case "msg": return "message";
    case "activity": return "activity";
    case "permission": return "permission";
    case "handoff": return "transition";
    case "meta": return "protocol";
    case "raw": return "raw";
  }
}

/** @internal Shared byte-scanning primitives for the audit-log reader. */
export const SESSION_LOG_READER_INTERNALS = Object.freeze({
  hardMaxRecordBytes: HARD_MAX_RECORD_BYTES,
  forwardLines,
  backwardLines,
  readBytes,
  firstPhysical,
  readLastPhysical,
  lastCompleteOffset,
  digestPrefix,
  sha256Bytes,
  positiveInteger,
  nonnegativeInteger,
  integrityTag,
});
