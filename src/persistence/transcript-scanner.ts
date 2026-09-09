import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalizeJson } from "./integrity.ts";
import {
  reduceTranscriptHistory,
  reduceTranscriptState,
  TranscriptReductionError,
  type TranscriptHistoryReduction,
  type TranscriptReductionResult,
  type TranscriptStructuralRecord,
} from "./reducer.ts";
import {
  validateTranscriptRecord,
  type KnownTranscriptRecord,
  type TranscriptCheckpointRecord,
  type TranscriptHeaderRecord,
  type TranscriptTransitionRecord,
} from "./records.ts";

const HARD_MAX_RECORD_BYTES = 16_777_216;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const KNOWN_TYPES = new Set([
  "header", "checkpoint", "operation", "message", "reasoning", "activity",
  "configuration", "permission", "transition", "metering_reference", "lifecycle",
  "protocol", "raw",
]);

export interface TranscriptScanExpectation {
  readonly agentSessionId?: string;
  readonly transcriptId?: string;
  readonly generation?: number;
}

export interface TranscriptContinuationScan {
  readonly header: TranscriptHeaderRecord;
  readonly selectedCheckpointRecord: TranscriptCheckpointRecord;
  readonly historyAtSelectedCheckpoint: TranscriptHistoryReduction;
  readonly reduction: TranscriptReductionResult;
  /** Structural records physically following the selected checkpoint record. */
  readonly structuralTailAfterSelectedCheckpoint: readonly TranscriptStructuralRecord[];
  readonly lastCompleteSequence: number;
  readonly lastCompleteOffset: number;
  /** File size captured before the scan; later appends are excluded from this result. */
  readonly snapshotBytes: number;
  readonly ignoredTrailingBytes: number;
  /** At least one retained message lost text or structured detail to engraved limits. */
  readonly conversationTruncated: boolean;
}

export class TranscriptNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`transcript does not exist: ${path}`);
    this.name = "TranscriptNotFoundError";
  }
}

export class TranscriptUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptUnavailableError";
  }
}

export class TranscriptCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptCorruptionError";
  }
}

export class TranscriptIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptIdentityError";
  }
}

export async function scanTranscriptContinuation(
  path: string,
  expected: TranscriptScanExpectation = {},
): Promise<TranscriptContinuationScan> {
  if (!isAbsolute(path)) throw new TranscriptUnavailableError("transcript path must be absolute");
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new TranscriptNotFoundError(path);
    throw new TranscriptUnavailableError(`cannot open transcript: ${path}`, { cause: error });
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TranscriptUnavailableError(`transcript is not a regular file: ${path}`);
    return await scanOpenTranscript(handle, path, expected);
  } catch (error) {
    if (error instanceof TranscriptNotFoundError
      || error instanceof TranscriptUnavailableError
      || error instanceof TranscriptCorruptionError
      || error instanceof TranscriptIdentityError) throw error;
    throw new TranscriptUnavailableError(`cannot safely read transcript: ${path}`, { cause: error });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function scanOpenTranscript(
  handle: FileHandle,
  path: string,
  expected: TranscriptScanExpectation,
): Promise<TranscriptContinuationScan> {
  let header: TranscriptHeaderRecord | null = null;
  let selected: TranscriptCheckpointRecord | null = null;
  let selectedHistory: TranscriptHistoryReduction | null = null;
  let structuralTail: TranscriptStructuralRecord[] = [];
  const activations: TranscriptTransitionRecord[] = [];
  let sequence = 0;
  let conversationTruncated = false;
  let lastCompleteOffset = 0;
  const snapshotSize = (await handle.stat()).size;

  for await (const physical of completeLines(handle, snapshotSize)) {
    if (!header) {
      const candidate = tryParseJsonObject(physical.bytes);
      if (!candidate || candidate.v !== 2) {
        // A linked v1 prefix is presentation-only and retains its permissive reader rules.
        lastCompleteOffset = physical.endOffset;
        continue;
      }
      let upgrade: KnownTranscriptRecord;
      try {
        validateTranscriptRecord(candidate, { transcriptPath: path });
        upgrade = candidate;
      } catch (error) {
        throw new TranscriptCorruptionError("invalid v2 header after legacy prefix", { cause: error });
      }
      if (upgrade.t !== "header" || upgrade.seq !== 1) {
        corrupt("first v2 record must be the transcript header", 1);
      }
      if (physical.startOffset > 0) {
        if (upgrade.event !== "upgraded"
          || upgrade.upgradedFrom?.boundaryOffset !== physical.startOffset) {
          corrupt("mixed transcript has an invalid declared legacy boundary", 1);
        }
      } else if (upgrade.event === "upgraded" && upgrade.upgradedFrom?.boundaryOffset !== 0) {
        corrupt("upgrade header boundary does not match its physical position", 1);
      }
      assertExpectedHeaderIdentity(upgrade, expected);
      if (physical.bytes.byteLength > upgrade.effectiveLimits.maxRecordBytes) {
        corrupt("header exceeds its engraved maxRecordBytes", 1);
      }
      header = upgrade;
      sequence = 1;
      lastCompleteOffset = physical.endOffset;
      continue;
    }

    if (physical.bytes.byteLength === 0) corrupt("empty complete line", sequence + 1);
    const maxBytes = header?.effectiveLimits.maxRecordBytes ?? HARD_MAX_RECORD_BYTES;
    if (physical.bytes.byteLength > maxBytes) {
      corrupt(`record exceeds effective maxRecordBytes (${physical.bytes.byteLength} > ${maxBytes})`, sequence + 1);
    }
    const raw = parseJsonObject(physical.bytes, sequence + 1);
    const nextSequence = sequence + 1;
    assertEnvelopeIdentity(raw, header, expected, nextSequence);
    sequence = nextSequence;
    lastCompleteOffset = physical.endOffset;

    if (!KNOWN_TYPES.has(raw.t as string)) {
      validateUnknownEnvelope(raw, nextSequence);
      continue;
    }

    let record: KnownTranscriptRecord;
    try {
      validateTranscriptRecord(raw, {
        ...(header ? {
          agentSessionId: header.agentSessionId,
          logId: header.transcriptId,
          generation: header.generation,
          transcriptPath: path,
        } : {}),
      });
      record = raw;
    } catch (error) {
      throw new TranscriptCorruptionError(`invalid transcript record at sequence ${nextSequence}`, { cause: error });
    }

    if (record.t === "header") corrupt("transcript generation contains more than one header", nextSequence);
    if (record.t === "message" && (record.truncation?.length ?? 0) > 0) {
      conversationTruncated = true;
    }

    if (record.t === "transition" && record.event === "target_activated") activations.push(record);
    if (!isStructural(record)) continue;

    if (record.t !== "checkpoint") {
      if (!selected) corrupt("structural record appears before the initial checkpoint", nextSequence);
      structuralTail.push(record);
      continue;
    }

    const history = historyThrough(activations, record.checkpoint.transcript!.coveredSequence);
    if (!selected) {
      validateReduction(record, history, []);
    } else {
      structuralTail.push(record);
      validateReduction(selected, selectedHistory!, structuralTail);
    }
    selected = record;
    selectedHistory = history;
    structuralTail = [];
  }

  if (!header) throw new TranscriptCorruptionError("transcript has no complete header");
  if (!selected || !selectedHistory) throw new TranscriptCorruptionError("transcript has no complete checkpoint");
  const reduction = validateReduction(selected, selectedHistory, structuralTail);
  return {
    header,
    selectedCheckpointRecord: selected,
    historyAtSelectedCheckpoint: selectedHistory,
    reduction,
    structuralTailAfterSelectedCheckpoint: structuralTail.map((record) => structuredClone(record)),
    lastCompleteSequence: sequence,
    lastCompleteOffset,
    snapshotBytes: snapshotSize,
    ignoredTrailingBytes: snapshotSize - lastCompleteOffset,
    conversationTruncated,
  };
}

function historyThrough(
  activations: readonly TranscriptTransitionRecord[],
  coveredSequence: number,
): TranscriptHistoryReduction {
  return reduceTranscriptHistory(activations.filter((record) => record.seq <= coveredSequence));
}

function validateReduction(
  checkpoint: TranscriptCheckpointRecord,
  history: TranscriptHistoryReduction,
  tail: readonly TranscriptStructuralRecord[],
): TranscriptReductionResult {
  try {
    return reduceTranscriptState(checkpoint, history, tail);
  } catch (error) {
    if (error instanceof TranscriptReductionError) {
      throw new TranscriptCorruptionError("transcript structural reduction failed", { cause: error });
    }
    throw error;
  }
}

function isStructural(record: KnownTranscriptRecord): record is TranscriptStructuralRecord {
  return record.t === "checkpoint" || record.t === "operation" || record.t === "transition";
}

function parseJsonObject(bytes: Buffer, sequence: number): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(UTF8.decode(bytes));
    if (!isRecord(value)) corrupt("record must be a JSON object", sequence);
    return value;
  } catch (error) {
    if (error instanceof TranscriptCorruptionError) throw error;
    throw new TranscriptCorruptionError(`malformed complete JSON at sequence ${sequence}`, { cause: error });
  }
}

function assertEnvelopeIdentity(
  value: Record<string, unknown>,
  header: TranscriptHeaderRecord | null,
  expected: TranscriptScanExpectation,
  sequence: number,
): void {
  if (value.seq !== sequence) corrupt(`expected sequence ${sequence}`, sequence);
  if (value.v !== 2) corrupt(`unsupported transcript version at sequence ${sequence}`, sequence);
  if (header) {
    if (value.agentSessionId !== header.agentSessionId
      || value.transcriptId !== header.transcriptId
      || value.generation !== header.generation) {
      throw new TranscriptIdentityError(`transcript identity changes at sequence ${sequence}`);
    }
  }
  const agentSessionId = header?.agentSessionId ?? value.agentSessionId;
  const transcriptId = header?.transcriptId ?? value.transcriptId;
  const generation = header?.generation ?? value.generation;
  if (expected.agentSessionId !== undefined && agentSessionId !== expected.agentSessionId) {
    throw new TranscriptIdentityError("agentSessionId does not match requested transcript identity");
  }
  if (expected.transcriptId !== undefined && transcriptId !== expected.transcriptId) {
    throw new TranscriptIdentityError("transcriptId does not match requested transcript identity");
  }
  if (expected.generation !== undefined && generation !== expected.generation) {
    throw new TranscriptIdentityError("transcript generation does not match requested identity");
  }
}

function validateUnknownEnvelope(value: Record<string, unknown>, sequence: number): void {
  try {
    canonicalizeJson(value);
  } catch (error) {
    throw new TranscriptCorruptionError(`unknown record at sequence ${sequence} is not canonical JSON`, { cause: error });
  }
  if (typeof value.t !== "string" || !value.t) corrupt("unknown record type must be nonblank", sequence);
  if (typeof value.agentSessionId !== "string" || !value.agentSessionId
    || typeof value.transcriptId !== "string" || !value.transcriptId
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || !Number.isSafeInteger(value.ts)) {
    corrupt("unknown record has an invalid envelope", sequence);
  }
}

interface CompleteLine {
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
}

async function* completeLines(handle: FileHandle, snapshotSize: number): AsyncGenerator<CompleteLine> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let position = 0;
  while (position < snapshotSize) {
    const requested = Math.min(chunk.byteLength, snapshotSize - position);
    const read = await handle.read(chunk, 0, requested, position);
    if (read.bytesRead === 0) {
      throw new TranscriptUnavailableError("transcript was truncated while it was being read");
    }
    position += read.bytesRead;
    const combined = pending.byteLength === 0
      ? Buffer.from(chunk.subarray(0, read.bytesRead))
      : Buffer.concat([pending, chunk.subarray(0, read.bytesRead)]);
    let start = 0;
    for (;;) {
      const newline = combined.indexOf(0x0a, start);
      if (newline < 0) break;
      const bytes = combined.subarray(start, newline);
      const startOffset = position - combined.byteLength + start;
      const endOffset = position - combined.byteLength + newline + 1;
      yield { bytes, startOffset, endOffset };
      start = newline + 1;
    }
    pending = Buffer.from(combined.subarray(start));
    if (pending.byteLength > HARD_MAX_RECORD_BYTES) {
      throw new TranscriptCorruptionError("incomplete or oversized transcript record exceeds the hard safety ceiling");
    }
  }
  // A nonempty pending suffix is a torn final line and intentionally ignored.
}

function tryParseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(UTF8.decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function assertExpectedHeaderIdentity(
  header: TranscriptHeaderRecord,
  expected: TranscriptScanExpectation,
): void {
  if (expected.agentSessionId !== undefined && header.agentSessionId !== expected.agentSessionId) {
    throw new TranscriptIdentityError("agentSessionId does not match requested transcript identity");
  }
  if (expected.transcriptId !== undefined && header.transcriptId !== expected.transcriptId) {
    throw new TranscriptIdentityError("transcriptId does not match requested transcript identity");
  }
  if (expected.generation !== undefined && header.generation !== expected.generation) {
    throw new TranscriptIdentityError("transcript generation does not match requested identity");
  }
}

function corrupt(message: string, sequence?: number): never {
  throw new TranscriptCorruptionError(sequence === undefined ? message : `${message} (sequence ${sequence})`);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
