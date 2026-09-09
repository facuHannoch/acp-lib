import {
  AgentSession,
  type AgentSessionOpenResult,
} from "../agent-session.ts";
import type { ManagedAgentSessionLoadConfig } from "./managed-load.ts";
import { loadManagedAgentSession, persistenceFromManagedRecord } from "./managed-load.ts";
import { attachManagedRegistryPublisher, projectManagedAgentSessionRecord } from "./managed-registry.ts";
import {
  AgentSessionStoreConflictError,
  type AgentSessionRecord,
  type AgentSessionStore,
  type RestorationMaintenance,
  type StagedContinuationState,
} from "./registry.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import { acquireSessionLogWriterLock } from "./session-log-writer.ts";
import type { SessionLogWriterLock } from "./session-log-writer.ts";
import { AuditPersistenceRuntime } from "./audit-runtime.ts";
import { createAgentSessionCheckpoint } from "./checkpoint.ts";
import type {
  AuditLogConfig,
  ResolvedAuditLogConfig,
  ResolvedTranscriptConfig,
  TranscriptConfig,
} from "./config.ts";
import { resolveDirectPersistence } from "./config.ts";
import { FileSessionLogWriter } from "./session-log-writer.ts";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { scanTranscriptContinuation } from "./transcript-scanner.ts";

export interface RestoreAgentSessionOptions extends ManagedAgentSessionLoadConfig {
  readonly restorationId: string;
  readonly expectedIncarnationId: string;
  readonly expectedRecordRevision: number;
  readonly replacementTranscript?: false | (TranscriptConfig & { readonly path: string });
  readonly replacementAuditLog?: false | (AuditLogConfig & { readonly path: string });
}

export class AgentSessionRestorationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionRestorationError";
  }
}

/** Reactivate a tombstone whose authoritative transcript was retained. */
export async function restoreManagedAgentSession(
  store: AgentSessionStore,
  agentSessionId: string,
  options: RestoreAgentSessionOptions,
): Promise<AgentSessionOpenResult> {
  validateOptions(agentSessionId, options);
  const record = await store.getAgentSessionRecord(agentSessionId);
  if (!record) throw new AgentSessionStoreConflictError("agent-session record does not exist");
  if (record.incarnationId !== options.expectedIncarnationId
    || record.recordRevision !== options.expectedRecordRevision) {
    return await completedOrConflict(store, agentSessionId, record, options);
  }
  if (!record.deletion) throw new AgentSessionRestorationError("only a deleted managed session can be restored");
  const retainedTranscript = record.transcript && !record.deletion.transcriptDeletedAt
    ? record.transcript : null;
  const retainedAudit = record.auditLog && !record.deletion.auditLogDeletedAt
    ? record.auditLog : null;
  if (!retainedTranscript && options.replacementTranscript === undefined) {
    throw new AgentSessionRestorationError(
      "a deleted transcript requires explicit replacementTranscript:false or a replacement",
    );
  }
  if (retainedTranscript && options.replacementTranscript !== undefined) {
    throw new AgentSessionRestorationError("a retained transcript cannot be replaced during this restoration slice");
  }
  if (!retainedAudit && record.auditLog && options.replacementAuditLog === undefined) {
    throw new AgentSessionRestorationError("deleted audit-log state must be explicitly disabled or replaced");
  }
  const requestDigest = restorationDigest(agentSessionId, options);
  const transcriptPath = retainedTranscript?.path
    ?? (options.replacementTranscript
      ? options.replacementTranscript.path : null);
  const auditPath = retainedAudit?.path
    ?? (options.replacementAuditLog
      ? options.replacementAuditLog.path : null);
  const locks = await acquireOrderedLocks([
    transcriptPath,
    auditPath,
  ]);
  const transcriptLock = transcriptPath ? locks.get(transcriptPath) : undefined;
  const auditLock = auditPath ? locks.get(auditPath) : undefined;
  let transferred = false;
  let opened: AgentSessionOpenResult | null = null;
  try {
    const proposed = restorationMaintenance(record, options, requestDigest);
    const prepared = await store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: options.expectedRecordRevision,
    });
    if (prepared.status === "already_completed") {
      throw new AgentSessionRestorationError("restoration already completed; load the active session");
    }
    if (prepared.maintenance.kind !== "restoration") {
      throw new AgentSessionRestorationError("prepared maintenance is not restoration");
    }
    if (prepared.maintenance.details.stagedRecord) {
      await store.finalizeMaintenance(
        agentSessionId, record.incarnationId, options.restorationId, requestDigest,
        { save: prepared.maintenance.details.stagedRecord },
      );
      await Promise.all([...locks.values()].map((lock) => lock.release().catch(() => undefined)));
      transferred = true;
      return await loadManagedAgentSession(store, agentSessionId, runtimeOptions(options));
    }
    const runtime = runtimeOptions(options);
    const authorityRecord = await prepareRestorationAuthority(
      record, options, requestDigest, prepared.maintenance.startedAt,
    );
    const activeAudit = authorityRecord.auditLog;
    const audit = activeAudit
      ? await AuditPersistenceRuntime.resume({
          path: activeAudit.path,
          agentSessionId,
          auditLogId: activeAudit.auditLogId,
          generation: activeAudit.generation,
          writerLock: auditLock,
        })
      : undefined;
    transferred = true;
    opened = authorityRecord.transcript
      ? await AgentSession.openManaged({
          ...runtime,
          agentSessionId,
          persistence: persistenceFromManagedRecord(authorityRecord),
        }, transcriptLock, audit)
      : await AgentSession.openManagedRegistry({
          ...runtime,
          agentSessionId,
          checkpoint: authorityRecord.checkpoint,
          persistence: {
            transcript: false,
            auditLog: authorityRecord.auditLog ? {
              path: authorityRecord.auditLog.path,
              capture: authorityRecord.auditLog.effectivePolicy,
              includeTruncationDigests: authorityRecord.auditLog.includeTruncationDigests,
            } : false,
            sessionConfiguration: authorityRecord.sessionConfigurationPersistence ?? { values: "typed" },
          },
        }, authorityRecord.internalSessionHistory, audit);
    const snapshot = await opened.session.publishManagedRestorationCheckpoint();
    const currentMaintenance = prepared.maintenance;
    const stagedContinuation: StagedContinuationState = {
      adapterId: snapshot.checkpoint.adapterId,
      mode: snapshot.checkpoint.mode,
      internalSessionId: snapshot.checkpoint.internalSessionId,
      internalSessionActivatedAt: snapshot.checkpoint.internalSessionActivatedAt,
      model: snapshot.checkpoint.model,
      sessionConfiguration: snapshot.checkpoint.sessionConfiguration,
      protocol: snapshot.checkpoint.protocol,
    };
    const { deletion: _deletion, ...activeRecord } = authorityRecord;
    const projected = projectManagedAgentSessionRecord(
      { ...activeRecord, recordRevision: record.recordRevision },
      snapshot.checkpoint,
      snapshot.internalSessionHistory,
      { lastOpenedAt: snapshot.checkpoint.updatedAt },
    );
    const existingContinuation = currentMaintenance.details.stagedContinuation;
    if (existingContinuation
      && (existingContinuation.adapterId !== stagedContinuation.adapterId
        || existingContinuation.internalSessionId !== stagedContinuation.internalSessionId)) {
      throw new AgentSessionRestorationError("restored continuation disagrees with staged provider identity");
    }
    const continuationStaged: RestorationMaintenance = existingContinuation
      ? currentMaintenance
      : { ...currentMaintenance, details: { ...currentMaintenance.details, stagedContinuation } };
    if (!existingContinuation) {
      await store.updateMaintenance(
        agentSessionId, record.incarnationId, options.restorationId, continuationStaged,
      );
    }
    const staged: RestorationMaintenance = {
      ...continuationStaged,
      details: { ...continuationStaged.details, stagedRecord: projected },
    };
    await store.updateMaintenance(
      agentSessionId, record.incarnationId, options.restorationId, staged,
    );
    await store.finalizeMaintenance(
      agentSessionId,
      record.incarnationId,
      options.restorationId,
      requestDigest,
      { save: projected },
    );
    attachManagedRegistryPublisher(opened.session, store);
    return opened;
  } catch (error) {
    await opened?.session.stop().catch(() => undefined);
    throw error;
  } finally {
    if (!transferred) {
      await Promise.all([...locks.values()].map((lock) => lock.release().catch(() => undefined)));
    }
  }
}

async function prepareRestorationAuthority(
  record: AgentSessionRecord,
  options: RestoreAgentSessionOptions,
  requestDigest: string,
  createdAt: string,
): Promise<AgentSessionRecord> {
  const keepTranscript = record.transcript !== null && record.deletion?.transcriptDeletedAt === undefined;
  const keepAudit = record.auditLog !== null && record.deletion?.auditLogDeletedAt === undefined;
  let checkpoint = record.checkpoint;
  let transcript = keepTranscript ? record.transcript : null;
  if (!keepTranscript && options.replacementTranscript) {
    const config = options.replacementTranscript;
    const resolved = resolveDirectPersistence({
      transcript: config, auditLog: false,
      sessionConfiguration: record.sessionConfigurationPersistence,
      limits: record.transcript?.effectiveLimits,
    });
    if (resolved === false || resolved.transcript === false) throw new AgentSessionRestorationError("replacement transcript is disabled");
    const transcriptId = stableReplacementId(requestDigest, "transcript");
    const { version: _version, digest: _digest, ...input } = checkpoint;
    checkpoint = createAgentSessionCheckpoint({
      ...input,
      stateRevision: checkpoint.stateRevision + 1,
      transcript: { transcriptId, generation: 1, path: config.path, coveredSequence: 1 },
      updatedAt: createdAt,
    });
    await installRestorationTranscript(record, config.path, resolved.transcript, resolved.limits, checkpoint, transcriptId, options.restorationId, requestDigest, createdAt);
    transcript = {
      path: config.path, transcriptId, generation: 1,
      preset: resolved.transcript.preset,
      effectivePolicy: resolved.transcript.capture,
      effectiveLimits: resolved.limits,
      includeTruncationDigests: resolved.transcript.includeTruncationDigests,
    };
  } else if (!keepTranscript && checkpoint.transcript) {
    const { version: _version, digest: _digest, ...input } = checkpoint;
    checkpoint = createAgentSessionCheckpoint({
      ...input,
      stateRevision: checkpoint.stateRevision + 1,
      transcript: null,
      updatedAt: createdAt,
    });
  }
  let auditLog = keepAudit ? record.auditLog : null;
  if (!keepAudit && options.replacementAuditLog) {
    const config = options.replacementAuditLog;
    const resolved = resolveDirectPersistence({ transcript: false, auditLog: config, limits: record.auditLog?.effectiveLimits });
    if (resolved === false || resolved.auditLog === false) throw new AgentSessionRestorationError("replacement audit log is disabled");
    const auditLogId = stableReplacementId(requestDigest, "audit");
    await installRestorationAudit(record, config.path, resolved.auditLog, resolved.limits, auditLogId, options.restorationId, requestDigest, createdAt);
    auditLog = {
      path: config.path, auditLogId, generation: 1,
      effectivePolicy: resolved.auditLog.capture,
      effectiveLimits: resolved.limits,
      includeTruncationDigests: resolved.auditLog.includeTruncationDigests,
    };
  }
  return { ...record, checkpoint, transcript, auditLog };
}

async function acquireOrderedLocks(paths: readonly (string | null)[]): Promise<Map<string, SessionLogWriterLock>> {
  const locks = new Map<string, SessionLogWriterLock>();
  try {
    for (const path of [...new Set(paths.filter((value): value is string => value !== null))]
      .sort((left, right) => left.localeCompare(right))) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700).catch(() => undefined);
      locks.set(path, await acquireSessionLogWriterLock(path));
    }
    return locks;
  } catch (error) {
    await Promise.all([...locks.values()].map((lock) => lock.release().catch(() => undefined)));
    throw error;
  }
}

function stableReplacementId(requestDigest: string, kind: "transcript" | "audit"): string {
  return `${kind}-${sha256CanonicalJson({ requestDigest, kind }).slice(0, 32)}`;
}

async function installRestorationTranscript(
  record: AgentSessionRecord,
  path: string,
  config: ResolvedTranscriptConfig,
  limits: NonNullable<AgentSessionRecord["transcript"]>["effectiveLimits"],
  checkpoint: AgentSessionRecord["checkpoint"],
  transcriptId: string,
  operationId: string,
  requestDigest: string,
  createdAt: string,
): Promise<void> {
  if (await exists(path)) {
    const scan = await scanTranscriptContinuation(path, {
      agentSessionId: record.agentSessionId, transcriptId, generation: 1,
    });
    if (scan.reduction.checkpoint.digest !== checkpoint.digest) {
      throw new AgentSessionRestorationError("existing restoration transcript has another checkpoint");
    }
    return;
  }
  const temp = `${path}.restoration-${requestDigest.slice(0, 24)}`;
  await unlink(temp).catch(() => undefined);
  const writer = await FileSessionLogWriter.create({
    kind: "transcript", path: temp, logicalPath: path,
    header: {
      v: 2, t: "header", transcriptId, generation: 1,
      agentSessionId: record.agentSessionId, seq: 1, ts: Date.parse(createdAt),
      event: "replaced", createdAt,
      preset: config.preset,
      effectivePolicy: config.capture,
      effectiveLimits: limits,
      includeTruncationDigests: config.includeTruncationDigests,
      installation: { kind: "restoration", operationId, requestDigest },
    },
    maxRecordBytes: limits.maxRecordBytes,
  });
  try {
    await writer.append({
      v: 2, t: "checkpoint", transcriptId, generation: 1,
      agentSessionId: record.agentSessionId, seq: 2, ts: Date.parse(createdAt),
      stateRevision: checkpoint.stateRevision, checkpoint,
    }, { durable: true });
  } finally {
    await writer.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function installRestorationAudit(
  record: AgentSessionRecord,
  path: string,
  config: ResolvedAuditLogConfig,
  limits: NonNullable<AgentSessionRecord["auditLog"]>["effectiveLimits"],
  auditLogId: string,
  operationId: string,
  requestDigest: string,
  createdAt: string,
): Promise<void> {
  if (await exists(path)) return;
  const temp = `${path}.restoration-${requestDigest.slice(0, 24)}`;
  await unlink(temp).catch(() => undefined);
  const writer = await FileSessionLogWriter.create({
    kind: "audit", path: temp,
    header: {
      v: 1, t: "header", auditLogId, generation: 1,
      agentSessionId: record.agentSessionId, seq: 1, ts: Date.parse(createdAt),
      event: "replaced", createdAt,
      effectivePolicy: config.capture,
      effectiveLimits: limits,
      includeTruncationDigests: config.includeTruncationDigests,
      installation: { kind: "restoration", operationId, requestDigest },
    },
    maxRecordBytes: limits.maxRecordBytes,
  });
  await writer.close();
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AgentSessionRestorationError(`replacement destination is not a regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function runtimeOptions(options: RestoreAgentSessionOptions): ManagedAgentSessionLoadConfig {
  const {
    restorationId: _restorationId,
    expectedIncarnationId: _expectedIncarnationId,
    expectedRecordRevision: _expectedRecordRevision,
    replacementTranscript: _replacementTranscript,
    replacementAuditLog: _replacementAuditLog,
    ...runtime
  } = options;
  return runtime;
}

async function completedOrConflict(
  store: AgentSessionStore,
  id: string,
  record: AgentSessionRecord,
  options: RestoreAgentSessionOptions,
): Promise<never> {
  const result = await store.prepareMaintenance(
    id,
    restorationMaintenance(record, options, restorationDigest(id, options)),
    { expectedRecordRevision: options.expectedRecordRevision },
  );
  if (result.status === "already_completed") {
    throw new AgentSessionRestorationError("restoration already completed; load the active session");
  }
  throw new AgentSessionStoreConflictError("agent-session record compare-and-swap failed");
}

function restorationMaintenance(
  record: AgentSessionRecord,
  options: RestoreAgentSessionOptions,
  requestDigest: string,
): RestorationMaintenance {
  return {
    kind: "restoration",
    incarnationId: options.expectedIncarnationId,
    baseRecordRevision: options.expectedRecordRevision,
    operationId: options.restorationId,
    requestDigest,
    status: "prepared",
    startedAt: new Date().toISOString(),
    details: {
      transcript: record.transcript && !record.deletion?.transcriptDeletedAt
        ? { action: "retain", path: record.transcript.path }
        : options.replacementTranscript
          ? { action: "replace", path: options.replacementTranscript.path }
          : { action: "disable" },
      auditLog: record.auditLog && !record.deletion?.auditLogDeletedAt
        ? { action: "retain", path: record.auditLog.path }
        : options.replacementAuditLog
          ? { action: "replace", path: options.replacementAuditLog.path }
          : { action: "disable" },
    },
  };
}

function restorationDigest(id: string, options: RestoreAgentSessionOptions): string {
  return sha256CanonicalJson({
    agentSessionId: id,
    restorationId: options.restorationId,
    expectedIncarnationId: options.expectedIncarnationId,
    expectedRecordRevision: options.expectedRecordRevision,
    adapterId: options.adapterId,
    strategies: options.continuation?.strategies?.map((strategy) =>
      strategy.kind === "new_from_transcript"
        ? { kind: strategy.kind, strategyId: strategy.strategyId }
        : strategy.kind === "new_from_consumer_continuation"
          ? { kind: strategy.kind, continuationId: strategy.continuationId }
          : { kind: strategy.kind }) ?? [{ kind: "load_internal_session" }],
    replacementTranscript: options.replacementTranscript === undefined ? "retain" : options.replacementTranscript,
    replacementAuditLog: options.replacementAuditLog === undefined ? "retain" : options.replacementAuditLog,
  });
}

function validateOptions(id: string, options: RestoreAgentSessionOptions): void {
  if (!id.trim() || !options?.restorationId?.trim() || !options?.expectedIncarnationId?.trim()) {
    throw new AgentSessionRestorationError("session, restoration, and incarnation IDs must be nonblank");
  }
  if (!Number.isSafeInteger(options.expectedRecordRevision) || options.expectedRecordRevision < 1) {
    throw new AgentSessionRestorationError("expectedRecordRevision must be a positive safe integer");
  }
}
