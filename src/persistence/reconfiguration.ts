import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { TranscriptConfig } from "./config.ts";
import { resolveDirectPersistence } from "./config.ts";
import {
  createAgentSessionCheckpoint,
  validateAgentSessionCheckpoint,
  type AgentSessionCheckpoint,
} from "./checkpoint.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import { resolveSessionLogPaths } from "./paths.ts";
import {
  AgentSessionStoreConflictError,
  type AgentSessionRecord,
  type AgentSessionStore,
  type AgentSessionSummary,
  type PersistenceReconfigurationMaintenance,
} from "./registry.ts";
import { summarizeAgentSessionRecord } from "./registry.ts";
import type { TranscriptHeaderRecord } from "./records.ts";
import { FileSessionLogWriter, withSessionLogWriterLock } from "./session-log-writer.ts";

export interface ReconfigureAgentSessionPersistenceOptions {
  readonly reconfigurationId: string;
  readonly expectedIncarnationId: string;
  readonly expectedRecordRevision: number;
  readonly transcript?:
    | {
        readonly action: "disable";
        readonly checkpoint: AgentSessionCheckpoint;
        readonly deleteExistingLog: true;
        readonly acknowledgeContinuationLoss: true;
      }
    | {
        readonly action: "replace";
        readonly config: TranscriptConfig & { readonly path: string };
        readonly checkpoint: AgentSessionCheckpoint;
        readonly acknowledgeContinuationLoss: true;
      };
  readonly auditLog?: unknown;
}

export class AgentSessionPersistenceReconfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionPersistenceReconfigurationError";
  }
}

export async function reconfigureManagedAgentSessionPersistence(
  store: AgentSessionStore,
  agentSessionId: string,
  options: ReconfigureAgentSessionPersistenceOptions,
): Promise<AgentSessionSummary> {
  validateRequest(agentSessionId, options);
  if (options.auditLog !== undefined) {
    throw new AgentSessionPersistenceReconfigurationError("audit-log reconfiguration is not implemented yet");
  }
  const change = options.transcript!;
  const requestDigest = sha256CanonicalJson({
    agentSessionId,
    reconfigurationId: options.reconfigurationId,
    expectedIncarnationId: options.expectedIncarnationId,
    expectedRecordRevision: options.expectedRecordRevision,
    transcript: change.action === "disable"
      ? { action: "disable", checkpointDigest: change.checkpoint.digest }
      : { action: "replace", config: change.config, checkpointDigest: change.checkpoint.digest },
  });
  const retryPath = change.checkpoint.transcript?.path
    ?? (change.action === "replace" ? change.config.path : null);
  if (!retryPath) {
    throw new AgentSessionPersistenceReconfigurationError("the supplied checkpoint does not identify the transcript being disabled");
  }
  const candidate = await store.getAgentSessionRecord(agentSessionId);
  if (!candidate
    || candidate.incarnationId !== options.expectedIncarnationId
    || candidate.recordRevision !== options.expectedRecordRevision) {
    const completed = await store.prepareMaintenance(
      agentSessionId,
      proposedMaintenance(options, requestDigest, retryPath),
      { expectedRecordRevision: options.expectedRecordRevision },
    );
    if (completed.status === "already_completed" && candidate) {
      return summarizeAgentSessionRecord(candidate);
    }
    throw new AgentSessionStoreConflictError("agent-session record compare-and-swap failed");
  }
  const initial = candidate;
  if (!initial.transcript) {
    throw new AgentSessionPersistenceReconfigurationError("session has no transcript to reconfigure");
  }
  const path = initial.transcript.path;
  if (change.action === "replace") {
    const resolved = resolveDirectPersistence({
      root: dirname(dirname(path)),
      transcript: change.config,
      auditLog: false,
      sessionConfiguration: initial.sessionConfigurationPersistence,
      limits: initial.transcript.effectiveLimits,
    });
    if (resolved === false) throw new AgentSessionPersistenceReconfigurationError("replacement transcript is disabled");
    const paths = await resolveSessionLogPaths(resolved, agentSessionId);
    if (paths.transcriptPath !== path) {
      throw new AgentSessionPersistenceReconfigurationError("v0 replacement must retain the recorded transcript path");
    }
  }

  return await withSessionLogWriterLock(path, async () => {
    const record = await requireCurrent(store, agentSessionId, options);
    validateAgentSessionCheckpoint(change.checkpoint, {
      agentSessionId,
      incarnationId: record.incarnationId,
    });
    const proposed = proposedMaintenance(options, requestDigest, path);
    const prepared = await store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: options.expectedRecordRevision,
    });
    if (prepared.status === "already_completed") {
      const completed = await store.getAgentSessionRecord(agentSessionId);
      if (!completed) throw new AgentSessionStoreConflictError("completed reconfiguration record disappeared");
      return summarizeAgentSessionRecord(completed);
    }
    if (prepared.maintenance.kind !== "persistence_reconfiguration") {
      throw new AgentSessionPersistenceReconfigurationError("prepared maintenance is not persistence reconfiguration");
    }

    const at = prepared.maintenance.startedAt < record.updatedAt
      ? record.updatedAt
      : prepared.maintenance.startedAt;
    const nextCheckpoint = change.action === "disable"
      ? reconfiguredCheckpoint(change.checkpoint, at, null)
      : await installReplacement(record, change.config, change.checkpoint, path, requestDigest, options.reconfigurationId, at);
    if (change.action === "disable") await removeAndSync(path);
    const { deletion: _deletion, ...activeRecord } = record;
    const next: AgentSessionRecord = {
      ...activeRecord,
      recordRevision: record.recordRevision + 1,
      checkpoint: nextCheckpoint,
      transcript: change.action === "disable" ? null : {
        path,
        transcriptId: nextCheckpoint.transcript!.transcriptId,
        generation: nextCheckpoint.transcript!.generation,
        preset: change.config.preset ?? "activity",
        effectivePolicy: resolveReplacementPolicy(record, change.config),
        effectiveLimits: record.transcript!.effectiveLimits,
        includeTruncationDigests: change.config.includeTruncationDigests ?? false,
      },
      updatedAt: at,
    };
    await store.finalizeMaintenance(
      agentSessionId,
      record.incarnationId,
      options.reconfigurationId,
      requestDigest,
      { save: next },
    );
    return summarizeAgentSessionRecord(next);
  });
}

function proposedMaintenance(
  options: ReconfigureAgentSessionPersistenceOptions,
  requestDigest: string,
  path: string,
): PersistenceReconfigurationMaintenance {
  return {
    kind: "persistence_reconfiguration",
    incarnationId: options.expectedIncarnationId,
    baseRecordRevision: options.expectedRecordRevision,
    operationId: options.reconfigurationId,
    requestDigest,
    status: "prepared",
    startedAt: new Date().toISOString(),
    details: {
      transcript: options.transcript!.action === "disable"
        ? { action: "disable", previousPath: path }
        : { action: "replace", previousPath: path, replacementPath: path },
      auditLog: null,
    },
  };
}

function reconfiguredCheckpoint(
  source: AgentSessionCheckpoint,
  updatedAt: string,
  transcript: AgentSessionCheckpoint["transcript"],
): AgentSessionCheckpoint {
  const { version: _version, digest: _digest, ...input } = source;
  return createAgentSessionCheckpoint({
    ...input,
    stateRevision: source.stateRevision + 1,
    transcript,
    updatedAt,
  });
}

async function installReplacement(
  record: AgentSessionRecord,
  config: TranscriptConfig & { readonly path: string },
  source: AgentSessionCheckpoint,
  path: string,
  requestDigest: string,
  operationId: string,
  updatedAt: string,
): Promise<AgentSessionCheckpoint> {
  const transcriptId = randomUUID();
  const tempPath = `${path}.replacement-${randomUUID()}`;
  const resolved = resolveDirectPersistence({
    transcript: config,
    auditLog: false,
    sessionConfiguration: record.sessionConfigurationPersistence,
    limits: record.transcript!.effectiveLimits,
  });
  if (resolved === false || resolved.transcript === false) throw new AgentSessionPersistenceReconfigurationError("replacement transcript is disabled");
  const checkpoint = reconfiguredCheckpoint(source, updatedAt, {
    transcriptId,
    generation: 1,
    path,
    coveredSequence: 1,
  });
  const header: TranscriptHeaderRecord = {
    v: 2,
    t: "header",
    transcriptId,
    generation: 1,
    agentSessionId: record.agentSessionId,
    seq: 1,
    ts: Date.parse(updatedAt),
    event: "replaced",
    createdAt: updatedAt,
    preset: resolved.transcript.preset,
    effectivePolicy: resolved.transcript.capture,
    effectiveLimits: resolved.limits,
    includeTruncationDigests: resolved.transcript.includeTruncationDigests,
    installation: { kind: "persistence_reconfiguration", operationId, requestDigest },
  };
  let writer: FileSessionLogWriter<"transcript"> | undefined;
  try {
    writer = await FileSessionLogWriter.create({
      kind: "transcript",
      path: tempPath,
      logicalPath: path,
      header,
      maxRecordBytes: resolved.limits.maxRecordBytes,
    });
    await writer.append({
      v: 2, t: "checkpoint", transcriptId, generation: 1,
      agentSessionId: record.agentSessionId, seq: 2, ts: Date.parse(updatedAt),
      stateRevision: checkpoint.stateRevision, checkpoint,
    }, { durable: true });
    await writer.close();
    writer = undefined;
    await rename(tempPath, path);
    await syncDirectory(dirname(path));
    return checkpoint;
  } catch (error) {
    await writer?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function resolveReplacementPolicy(record: AgentSessionRecord, config: TranscriptConfig) {
  const resolved = resolveDirectPersistence({
    transcript: config,
    auditLog: false,
    limits: record.transcript!.effectiveLimits,
  });
  if (resolved === false || resolved.transcript === false) throw new AgentSessionPersistenceReconfigurationError("replacement transcript is disabled");
  return resolved.transcript.capture;
}

async function requireCurrent(
  store: AgentSessionStore,
  id: string,
  options: ReconfigureAgentSessionPersistenceOptions,
): Promise<AgentSessionRecord> {
  const record = await store.getAgentSessionRecord(id);
  if (!record) throw new AgentSessionStoreConflictError("agent-session record does not exist");
  if (record.incarnationId !== options.expectedIncarnationId
    || record.recordRevision !== options.expectedRecordRevision) {
    throw new AgentSessionStoreConflictError("agent-session record compare-and-swap failed");
  }
  return record;
}

function validateRequest(id: string, options: ReconfigureAgentSessionPersistenceOptions): void {
  if (!id.trim() || !options?.reconfigurationId?.trim() || !options?.expectedIncarnationId?.trim()) {
    throw new AgentSessionPersistenceReconfigurationError("session, reconfiguration, and incarnation IDs must be nonblank");
  }
  if (!Number.isSafeInteger(options.expectedRecordRevision) || options.expectedRecordRevision < 1) {
    throw new AgentSessionPersistenceReconfigurationError("expectedRecordRevision must be a positive safe integer");
  }
  if (!options.transcript && options.auditLog === undefined) {
    throw new AgentSessionPersistenceReconfigurationError("at least one persistence change is required");
  }
  if (options.transcript?.action === "disable"
    && (!options.transcript.deleteExistingLog || !options.transcript.acknowledgeContinuationLoss)) {
    throw new AgentSessionPersistenceReconfigurationError("disabling a transcript requires deletion and continuation-loss acknowledgement");
  }
  if (options.transcript?.action === "replace" && !options.transcript.acknowledgeContinuationLoss) {
    throw new AgentSessionPersistenceReconfigurationError("replacing a transcript requires continuation-loss acknowledgement");
  }
}

async function removeAndSync(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
