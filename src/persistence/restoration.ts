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

export interface RestoreAgentSessionOptions extends ManagedAgentSessionLoadConfig {
  readonly restorationId: string;
  readonly expectedIncarnationId: string;
  readonly expectedRecordRevision: number;
  readonly replacementTranscript?: false | unknown;
  readonly replacementAuditLog?: false | unknown;
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
  if (!retainedTranscript && options.replacementTranscript !== false) {
    throw new AgentSessionRestorationError(
      "a deleted transcript requires explicit replacementTranscript:false or a replacement (not yet implemented)",
    );
  }
  if (retainedTranscript && options.replacementTranscript !== undefined) {
    throw new AgentSessionRestorationError("a retained transcript cannot be replaced during this restoration slice");
  }
  if (!retainedAudit && record.auditLog && options.replacementAuditLog !== false) {
    throw new AgentSessionRestorationError("deleted audit-log state must be explicitly disabled or replaced");
  }
  if ((options.replacementTranscript && options.replacementTranscript !== false)
    || (options.replacementAuditLog && options.replacementAuditLog !== false)) {
    throw new AgentSessionRestorationError("replacement artifact creation during restoration is not implemented yet");
  }

  const requestDigest = restorationDigest(agentSessionId, options);
  const locks = await acquireOrderedLocks([
    retainedTranscript?.path ?? null,
    retainedAudit?.path ?? null,
  ]);
  const transcriptLock = retainedTranscript ? locks.get(retainedTranscript.path) : undefined;
  const auditLock = retainedAudit ? locks.get(retainedAudit.path) : undefined;
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
    const authorityRecord = restorationAuthorityRecord(record, retainedTranscript !== null, retainedAudit !== null);
    const audit = retainedAudit
      ? await AuditPersistenceRuntime.resume({
          path: retainedAudit.path,
          agentSessionId,
          auditLogId: retainedAudit.auditLogId,
          generation: retainedAudit.generation,
          writerLock: auditLock,
        })
      : undefined;
    transferred = true;
    opened = retainedTranscript
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

function restorationAuthorityRecord(
  record: AgentSessionRecord,
  keepTranscript: boolean,
  keepAudit: boolean,
): AgentSessionRecord {
  if (keepTranscript && keepAudit) return record;
  let checkpoint = record.checkpoint;
  if (!keepTranscript && checkpoint.transcript) {
    const { version: _version, digest: _digest, ...input } = checkpoint;
    checkpoint = createAgentSessionCheckpoint({
      ...input,
      stateRevision: checkpoint.stateRevision + 1,
      transcript: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return { ...record, checkpoint, transcript: keepTranscript ? record.transcript : null, auditLog: keepAudit ? record.auditLog : null };
}

async function acquireOrderedLocks(paths: readonly (string | null)[]): Promise<Map<string, SessionLogWriterLock>> {
  const locks = new Map<string, SessionLogWriterLock>();
  try {
    for (const path of [...new Set(paths.filter((value): value is string => value !== null))]
      .sort((left, right) => left.localeCompare(right))) {
      locks.set(path, await acquireSessionLogWriterLock(path));
    }
    return locks;
  } catch (error) {
    await Promise.all([...locks.values()].map((lock) => lock.release().catch(() => undefined)));
    throw error;
  }
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
        : { action: "disable" },
      auditLog: record.auditLog && !record.deletion?.auditLogDeletedAt
        ? { action: "retain", path: record.auditLog.path }
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
