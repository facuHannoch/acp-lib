import { isAbsolute } from "node:path";
import type { SessionRecord, SessionStore } from "../session-store.ts";
import {
  validateAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionStore,
} from "./registry.ts";
import {
  scanTranscriptContinuation,
  TranscriptCorruptionError,
  TranscriptIdentityError,
  TranscriptNotFoundError,
  TranscriptUnavailableError,
} from "./transcript-scanner.ts";

export type LegacyRegistryImportStatus =
  | "imported"
  | "already_imported"
  | "conflict"
  | "skipped";

export type LegacyRegistryImportReason =
  | "missing_transcript"
  | "invalid_legacy_record"
  | "transcript_unavailable"
  | "transcript_corrupt"
  | "transcript_identity_mismatch"
  | "transcript_requires_recovery"
  | "target_identity_conflict";

export interface LegacyRegistryImportEntry {
  readonly agentSessionId: string;
  readonly status: LegacyRegistryImportStatus;
  readonly reason?: LegacyRegistryImportReason;
  readonly detail?: string;
}

export interface LegacyRegistryImportResult {
  readonly entries: readonly LegacyRegistryImportEntry[];
  readonly imported: number;
  readonly alreadyImported: number;
  readonly conflicts: number;
  readonly skipped: number;
}

/**
 * Explicitly import the old file-per-session routing catalog into a v2 registry.
 *
 * A legacy row is importable only after its transcript has a complete v2 continuation
 * boundary. This keeps the old routing catalog from becoming authority for fields it never
 * stored (model, protocol, configuration, activation time, or canonical history).
 */
export async function importLegacySessionRegistry(
  source: SessionStore,
  target: AgentSessionStore,
): Promise<LegacyRegistryImportResult> {
  const legacy = await source.list();
  const entries: LegacyRegistryImportEntry[] = [];
  for (const row of [...legacy].sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId))) {
    entries.push(await importOne(row, target));
  }
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    imported: entries.filter((entry) => entry.status === "imported").length,
    alreadyImported: entries.filter((entry) => entry.status === "already_imported").length,
    conflicts: entries.filter((entry) => entry.status === "conflict").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
  });
}

async function importOne(
  legacy: SessionRecord,
  target: AgentSessionStore,
): Promise<LegacyRegistryImportEntry> {
  const invalid = validateLegacyRow(legacy);
  if (invalid) return entry(legacy.agentSessionId || "<invalid>", "skipped", "invalid_legacy_record", invalid);
  if (!legacy.transcriptPath) {
    return entry(legacy.agentSessionId, "skipped", "missing_transcript", "legacy row has no transcript path");
  }

  let candidate: AgentSessionRecord;
  try {
    const scan = await scanTranscriptContinuation(legacy.transcriptPath, {
      agentSessionId: legacy.agentSessionId,
    });
    if (scan.reduction.recovery.kind !== "clean" || scan.reduction.repairs.length > 0) {
      return entry(
        legacy.agentSessionId,
        "skipped",
        "transcript_requires_recovery",
        "transcript must be clean and fully checkpointed before registry import",
      );
    }
    const checkpoint = scan.reduction.checkpoint;
    if (legacy.adapter !== checkpoint.adapterId
      || legacy.mode !== checkpoint.mode
      || legacy.internalSessionId !== checkpoint.internalSessionId) {
      return entry(
        legacy.agentSessionId,
        "conflict",
        "transcript_identity_mismatch",
        "legacy routing fields disagree with transcript continuation authority",
      );
    }
    candidate = recordFromLegacy(legacy, scan);
  } catch (error) {
    if (error instanceof TranscriptIdentityError) {
      return entry(legacy.agentSessionId, "conflict", "transcript_identity_mismatch", error.message);
    }
    if (error instanceof TranscriptNotFoundError) {
      return entry(legacy.agentSessionId, "skipped", "missing_transcript", error.message);
    }
    if (error instanceof TranscriptUnavailableError) {
      return entry(legacy.agentSessionId, "skipped", "transcript_unavailable", error.message);
    }
    if (error instanceof TranscriptCorruptionError) {
      return entry(legacy.agentSessionId, "skipped", "transcript_corrupt", error.message);
    }
    return entry(
      legacy.agentSessionId,
      "skipped",
      "transcript_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }

  const existing = await target.getAgentSessionRecord(legacy.agentSessionId);
  if (existing) {
    return sameImportedLineage(existing, candidate)
      ? entry(legacy.agentSessionId, "already_imported")
      : entry(legacy.agentSessionId, "conflict", "target_identity_conflict", "target registry already contains another incarnation");
  }

  try {
    await target.saveAgentSessionRecord(candidate, {
      expectedRecordRevision: null,
      expectedIncarnationId: null,
    });
    return entry(legacy.agentSessionId, "imported");
  } catch (error) {
    // Resolve a concurrent identical importer as idempotent; never overwrite a winner.
    const winner = await target.getAgentSessionRecord(legacy.agentSessionId);
    if (winner && sameImportedLineage(winner, candidate)) {
      return entry(legacy.agentSessionId, "already_imported");
    }
    return entry(
      legacy.agentSessionId,
      "conflict",
      "target_identity_conflict",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function recordFromLegacy(
  legacy: SessionRecord,
  scan: Awaited<ReturnType<typeof scanTranscriptContinuation>>,
): AgentSessionRecord {
  const checkpoint = scan.reduction.checkpoint;
  const header = scan.header;
  const updatedAt = Date.parse(legacy.updatedAt) > Date.parse(checkpoint.updatedAt)
    ? legacy.updatedAt
    : checkpoint.updatedAt;
  const record: AgentSessionRecord = {
    agentSessionId: checkpoint.agentSessionId,
    incarnationId: checkpoint.incarnationId,
    recordRevision: 1,
    checkpoint,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    internalSessionId: checkpoint.internalSessionId,
    internalSessionActivatedAt: checkpoint.internalSessionActivatedAt,
    internalSessionHistory: scan.reduction.internalSessionHistory,
    ...(legacy.cwd === undefined ? {} : { cwd: legacy.cwd }),
    ...(legacy.title === undefined ? {} : { title: legacy.title }),
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    protocol: checkpoint.protocol,
    transcript: {
      path: legacy.transcriptPath!,
      transcriptId: header.transcriptId,
      generation: header.generation,
      preset: header.preset,
      effectivePolicy: header.effectivePolicy,
      effectiveLimits: header.effectiveLimits,
      includeTruncationDigests: header.includeTruncationDigests,
    },
    auditLog: null,
    createdAt: legacy.createdAt,
    updatedAt,
    lastOpenedAt: updatedAt,
  };
  validateAgentSessionRecord(record);
  return record;
}

function sameImportedLineage(existing: AgentSessionRecord, candidate: AgentSessionRecord): boolean {
  return existing.agentSessionId === candidate.agentSessionId
    && existing.incarnationId === candidate.incarnationId
    && existing.transcript?.transcriptId === candidate.transcript?.transcriptId
    && existing.transcript?.generation === candidate.transcript?.generation;
}

function validateLegacyRow(row: SessionRecord): string | null {
  if (!row || typeof row !== "object") return "legacy row must be an object";
  if (typeof row.agentSessionId !== "string" || !row.agentSessionId.trim()) return "agentSessionId is invalid";
  if (typeof row.adapter !== "string" || !row.adapter.trim()) return "adapter is invalid";
  if (row.mode !== "normal" && row.mode !== "degraded") return "mode is invalid";
  if (row.internalSessionId !== null && (typeof row.internalSessionId !== "string" || !row.internalSessionId.trim())) {
    return "internalSessionId is invalid";
  }
  if (row.transcriptPath !== undefined && (typeof row.transcriptPath !== "string" || !isAbsolute(row.transcriptPath))) {
    return "transcriptPath must be absolute";
  }
  if (row.cwd !== undefined && (typeof row.cwd !== "string" || !row.cwd)) return "cwd is invalid";
  if (row.title !== undefined && (typeof row.title !== "string" || !row.title)) return "title is invalid";
  if (!isIso(row.createdAt) || !isIso(row.updatedAt)) return "timestamps are invalid";
  if (Date.parse(row.createdAt) > Date.parse(row.updatedAt)) return "createdAt is after updatedAt";
  return null;
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function entry(
  agentSessionId: string,
  status: LegacyRegistryImportStatus,
  reason?: LegacyRegistryImportReason,
  detail?: string,
): LegacyRegistryImportEntry {
  return {
    agentSessionId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}
