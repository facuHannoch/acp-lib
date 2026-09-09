import { randomUUID } from "node:crypto";
import { chmod, lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  resolveDirectPersistence,
  type PersistenceLimits,
  type TranscriptConfig,
} from "./config.ts";
import { createAgentSessionCheckpoint, type AgentSessionCheckpoint } from "./checkpoint.ts";
import { canonicalizeJson } from "./integrity.ts";
import {
  validateTranscriptRecord,
  type TranscriptCheckpointRecord,
  type TranscriptHeaderRecord,
} from "./records.ts";
import { EMPTY_HISTORY_DIGEST } from "./reducer.ts";
import type { StagedContinuationState } from "./registry.ts";
import { withSessionLogWriterLock } from "./session-log-writer.ts";
import { SESSION_LOG_READER_INTERNALS as IO } from "./transcript-reader.ts";

export interface MigrateLegacyTranscriptOptions {
  readonly path: string;
  readonly agentSessionId: string;
  readonly continuation: StagedContinuationState;
  readonly transcript?: Omit<TranscriptConfig, "path">;
  readonly limits?: Partial<PersistenceLimits>;
  readonly transcriptId?: string;
  readonly incarnationId?: string;
  /** Test/embedding clock; evaluated only when a new upgrade header is required. */
  readonly now?: () => Date;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface LegacyTranscriptMigrationResult {
  readonly status: "migrated" | "resumed" | "already_migrated";
  readonly header: TranscriptHeaderRecord;
  readonly checkpoint: AgentSessionCheckpoint;
  readonly legacyBoundaryOffset: number;
}

export class LegacyTranscriptMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyTranscriptMigrationError";
  }
}

/**
 * Establish a v2 continuation boundary after a legacy v1 transcript.
 *
 * Legacy lines remain presentation-only. The supplied continuation is complete authority;
 * no adapter, provider identity, model, protocol, or configuration is inferred from v1.
 */
export async function migrateLegacyTranscript(
  options: MigrateLegacyTranscriptOptions,
): Promise<LegacyTranscriptMigrationResult> {
  validateOptions(options);
  return withSessionLogWriterLock(options.path, async () => {
    try {
      const stat = await lstat(options.path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new LegacyTranscriptMigrationError("legacy transcript must be a regular non-symbolic-link file");
      }
      const handle = await open(options.path, "r+");
      try {
        const scan = await scanMigrationFile(handle, stat.size);
        if (scan.header && scan.checkpointRecord) {
          assertExistingMatches(scan.header, scan.checkpointRecord, options);
          return freezeResult("already_migrated", scan.header, scan.checkpointRecord.checkpoint);
        }

        const header = scan.header ?? createUpgradeHeader(options, scan.legacyBoundaryOffset);
        if (scan.header) assertHeaderRequestMatches(scan.header, options);
        const checkpoint = createMigrationCheckpoint(
          options,
          header,
          scan.checkpointRecord?.checkpoint.incarnationId ?? options.incarnationId ?? randomUUID(),
        );
        const record = checkpointRecord(header, checkpoint);

        if (stat.size !== scan.completeOffset) await handle.truncate(scan.completeOffset);
        let position = scan.completeOffset;
        if (!scan.header) {
          const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
          await handle.write(headerLine, 0, headerLine.byteLength, position);
          position += headerLine.byteLength;
          await handle.sync();
        }
        const checkpointLine = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        await handle.write(checkpointLine, 0, checkpointLine.byteLength, position);
        await handle.sync();
        await chmod(options.path, 0o600).catch(() => undefined);
        return freezeResult(scan.header ? "resumed" : "migrated", header, checkpoint);
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof LegacyTranscriptMigrationError) throw error;
      throw new LegacyTranscriptMigrationError("legacy transcript migration failed", { cause: error });
    }
  }, options);
}

interface MigrationScan {
  readonly legacyBoundaryOffset: number;
  readonly completeOffset: number;
  readonly header: TranscriptHeaderRecord | null;
  readonly checkpointRecord: TranscriptCheckpointRecord | null;
}

async function scanMigrationFile(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<MigrationScan> {
  if (size === 0) throw new LegacyTranscriptMigrationError("cannot migrate an empty transcript");
  const completeOffset = await IO.lastCompleteOffset(handle, size);
  let header: TranscriptHeaderRecord | null = null;
  let checkpointRecord: TranscriptCheckpointRecord | null = null;
  let legacyBoundaryOffset = completeOffset;
  for await (const physical of IO.forwardLines(handle, 0, completeOffset, IO.hardMaxRecordBytes)) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(physical.bytes));
    } catch {
      if (header) throw new LegacyTranscriptMigrationError("malformed complete record after v2 upgrade boundary");
      continue; // Historical v1 behavior deliberately skips malformed complete lines.
    }
    if (!isRecord(value) || value.v !== 2) {
      if (header) throw new LegacyTranscriptMigrationError("legacy record appears after v2 upgrade boundary");
      continue;
    }
    if (!header) {
      try {
        validateTranscriptRecord(value);
      } catch (error) {
        throw new LegacyTranscriptMigrationError("invalid v2 upgrade header in legacy transcript", { cause: error });
      }
      if (value.t !== "header" || value.event !== "upgraded") {
        throw new LegacyTranscriptMigrationError("v2 content already exists without an upgrade header");
      }
      header = value;
      legacyBoundaryOffset = physical.start;
      if (value.upgradedFrom!.boundaryOffset !== legacyBoundaryOffset) {
        throw new LegacyTranscriptMigrationError("upgrade header legacy boundary offset is invalid");
      }
      continue;
    }
    if (!checkpointRecord) {
      try {
        validateTranscriptRecord(value, {
          agentSessionId: header.agentSessionId,
          logId: header.transcriptId,
          generation: header.generation,
          transcriptPath: undefined,
        });
      } catch (error) {
        throw new LegacyTranscriptMigrationError("invalid initial checkpoint after upgrade header", { cause: error });
      }
      if (value.t !== "checkpoint" || value.seq !== 2) {
        throw new LegacyTranscriptMigrationError("upgrade header is not followed by its initial checkpoint");
      }
      checkpointRecord = value;
      continue;
    }
    // A completed migration may already have ordinary v2 append history. The migration
    // boundary is still idempotently discoverable; ordinary open owns validating its tail.
  }
  if (header && header.seq !== 1) throw new LegacyTranscriptMigrationError("upgrade header sequence must be 1");
  return { legacyBoundaryOffset, completeOffset, header, checkpointRecord };
}

function createUpgradeHeader(
  options: MigrateLegacyTranscriptOptions,
  boundaryOffset: number,
): TranscriptHeaderRecord {
  const persistence = resolveDirectPersistence({
    transcript: { path: options.path, ...options.transcript },
    auditLog: false,
    limits: options.limits,
  });
  if (persistence === false || persistence.transcript === false) {
    throw new LegacyTranscriptMigrationError("migration transcript policy is disabled");
  }
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const header: TranscriptHeaderRecord = {
    v: 2,
    t: "header",
    transcriptId: options.transcriptId ?? randomUUID(),
    generation: 1,
    agentSessionId: options.agentSessionId,
    seq: 1,
    ts: Date.parse(createdAt),
    event: "upgraded",
    createdAt,
    preset: persistence.transcript.preset,
    effectivePolicy: persistence.transcript.capture,
    effectiveLimits: persistence.limits,
    includeTruncationDigests: persistence.transcript.includeTruncationDigests,
    upgradedFrom: { version: 1, boundaryOffset },
  };
  validateTranscriptRecord(header);
  return header;
}

function createMigrationCheckpoint(
  options: MigrateLegacyTranscriptOptions,
  header: TranscriptHeaderRecord,
  incarnationId: string,
): AgentSessionCheckpoint {
  const continuation = options.continuation;
  return createAgentSessionCheckpoint({
    agentSessionId: options.agentSessionId,
    incarnationId,
    stateRevision: 1,
    adapterId: continuation.adapterId,
    mode: continuation.mode,
    internalSessionId: continuation.internalSessionId,
    internalSessionActivatedAt: continuation.internalSessionActivatedAt,
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST,
    model: continuation.model,
    sessionConfiguration: continuation.sessionConfiguration,
    protocol: continuation.protocol,
    transcript: {
      transcriptId: header.transcriptId,
      generation: 1,
      path: options.path,
      coveredSequence: 1,
    },
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: header.createdAt,
  });
}

function checkpointRecord(
  header: TranscriptHeaderRecord,
  checkpoint: AgentSessionCheckpoint,
): TranscriptCheckpointRecord {
  const record: TranscriptCheckpointRecord = {
    v: 2,
    t: "checkpoint",
    transcriptId: header.transcriptId,
    generation: 1,
    agentSessionId: header.agentSessionId,
    seq: 2,
    ts: header.ts,
    stateRevision: 1,
    checkpoint,
  };
  validateTranscriptRecord(record, {
    agentSessionId: header.agentSessionId,
    logId: header.transcriptId,
    generation: 1,
    transcriptPath: checkpoint.transcript?.path,
  });
  return record;
}

function assertExistingMatches(
  header: TranscriptHeaderRecord,
  record: TranscriptCheckpointRecord,
  options: MigrateLegacyTranscriptOptions,
): void {
  assertHeaderRequestMatches(header, options);
  const expected = createMigrationCheckpoint(options, header, record.checkpoint.incarnationId);
  if (canonicalizeJson(expected) !== canonicalizeJson(record.checkpoint)) {
    throw new LegacyTranscriptMigrationError("existing migration checkpoint disagrees with supplied continuation");
  }
}

function assertHeaderRequestMatches(header: TranscriptHeaderRecord, options: MigrateLegacyTranscriptOptions): void {
  if (header.agentSessionId !== options.agentSessionId) {
    throw new LegacyTranscriptMigrationError("existing upgrade belongs to another agent session");
  }
  if (options.transcriptId !== undefined && header.transcriptId !== options.transcriptId) {
    throw new LegacyTranscriptMigrationError("existing upgrade transcriptId disagrees with request");
  }
}

function freezeResult(
  status: LegacyTranscriptMigrationResult["status"],
  header: TranscriptHeaderRecord,
  checkpoint: AgentSessionCheckpoint,
): LegacyTranscriptMigrationResult {
  return Object.freeze({
    status,
    header: structuredClone(header),
    checkpoint: structuredClone(checkpoint),
    legacyBoundaryOffset: header.upgradedFrom!.boundaryOffset,
  });
}

function validateOptions(options: MigrateLegacyTranscriptOptions): void {
  if (!isAbsolute(options.path)) throw new LegacyTranscriptMigrationError("migration path must be absolute");
  if (!options.agentSessionId.trim()) throw new LegacyTranscriptMigrationError("agentSessionId must not be blank");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
