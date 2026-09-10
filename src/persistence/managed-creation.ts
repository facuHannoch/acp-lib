import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AgentSession,
  type AgentSessionConfig,
  type ManagedAgentSessionPersistenceSnapshot,
} from "../agent-session.ts";
import type {
  AgentSessionPersistenceOptions,
  ManagedSessionPersistenceOptions,
  ResolvedAgentSessionPersistence,
} from "./config.ts";
import { resolveSessionLogPaths } from "./paths.ts";
import {
  AgentSessionStoreConflictError,
  MaintenanceAlreadyCompletedError,
  type AgentSessionRecord,
  type AgentSessionStore,
  type CreationMaintenance,
} from "./registry.ts";
import type { InternalSessionHistoryEntry } from "./records.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import {
  acquireSessionLogWriterLock,
  type SessionLogWriterLock,
} from "./session-log-writer.ts";
import { attachManagedRegistryPublisher } from "./managed-registry.ts";
import { AuditPersistenceRuntime } from "./audit-runtime.ts";
import {
  createManagedOpenProgressReporter,
  type AgentSessionOpenProgressListener,
} from "./managed-open-progress.ts";

// Retain the former module-level export while the canonical error now applies to every
// maintenance kind and lives with the shared registry contract.
export { MaintenanceAlreadyCompletedError } from "./registry.ts";

export interface ManagedAgentSessionCreateConfig extends Omit<
  AgentSessionConfig,
  | "agentSessionId"
  | "creationId"
  | "providerSession"
  | "internalSessionId"
  | "sessions"
  | "persistence"
  | "transcriptPath"
  | "transcriptDir"
  | "mode"
> {
  /** Optional stable identity. Generated when omitted and discoverable through maintenance. */
  readonly agentSessionId?: string;
  /** Optional retry/incarnation identity. Generated when omitted. */
  readonly creationId?: string;
  readonly mode?: "normal";
  readonly persistence?: ManagedSessionPersistenceOptions;
  /** Observe ephemeral managed-open progress before the AgentSession is returned. */
  readonly onOpenProgress?: AgentSessionOpenProgressListener;
}

export class ManagedAgentSessionCreationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedAgentSessionCreationError";
  }
}

export interface ManagedCreationContext {
  readonly store: AgentSessionStore;
  readonly persistence: ResolvedAgentSessionPersistence;
}

/** @internal Transaction coordinator used by SessionManager.createAgentSession(). */
export async function createManagedAgentSession(
  context: ManagedCreationContext,
  config: ManagedAgentSessionCreateConfig,
): Promise<AgentSession> {
  if (config.mode !== undefined && config.mode !== "normal") {
    throw new ManagedAgentSessionCreationError("managed transcript creation currently requires normal ACP mode");
  }
  const agentSessionId = nonblankOrGenerated(config.agentSessionId, "agentSessionId");
  const creationId = nonblankOrGenerated(config.creationId, "creationId");
  const reportOpenProgress = createManagedOpenProgressReporter(
    config.onOpenProgress,
    config.logger,
  );
  const paths = await resolveSessionLogPaths(context.persistence, agentSessionId);
  const transcriptPath = paths.transcriptPath;
  const requestDigest = sha256CanonicalJson({
    agentSessionId,
    creationId,
    adapterId: config.adapterId,
    mode: "normal",
    cwd: config.cwd ?? null,
    title: config.title ?? null,
    transcript: context.persistence.transcript === false ? null : {
      path: transcriptPath,
      preset: context.persistence.transcript.preset,
      capture: context.persistence.transcript.capture,
      includeTruncationDigests: context.persistence.transcript.includeTruncationDigests,
    },
    sessionConfiguration: context.persistence.sessionConfiguration,
    limits: context.persistence.limits,
  });
  const proposed = creationMaintenance(creationId, requestDigest, transcriptPath, paths.auditLogPath);

  // Completed retries are answered without touching the artifact or starting a harness.
  if (await context.store.getAgentSessionRecord(agentSessionId)) {
    const result = await context.store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: null,
    });
    if (result.status === "already_completed") throw new MaintenanceAlreadyCompletedError(result.receipt);
    throw new AgentSessionStoreConflictError("managed creation requires an unused logical identity");
  }

  for (const path of [transcriptPath, paths.auditLogPath]) {
    if (!path) continue;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
  }
  const acquired = new Map<string, SessionLogWriterLock>();
  try {
    for (const path of [transcriptPath, paths.auditLogPath]
      .filter((value): value is string => value !== null)
      .sort((left, right) => left.localeCompare(right))) {
      acquired.set(path, await acquireSessionLogWriterLock(path));
    }
  } catch (error) {
    await Promise.all([...acquired.values()].map((lock) => lock.release().catch(() => undefined)));
    throw error;
  }
  const transcriptLock = transcriptPath ? acquired.get(transcriptPath) : undefined;
  const auditLogLock = paths.auditLogPath ? acquired.get(paths.auditLogPath) : undefined;
  let lockTransferred = false;
  let session: AgentSession | null = null;
  try {
    const priorMaintenance = await context.store.getMaintenance(agentSessionId);
    if (!priorMaintenance) {
      if (transcriptPath) await requireUninitializedDestination(transcriptPath);
      if (paths.auditLogPath) await requireUninitializedDestination(paths.auditLogPath);
    }
    const prepared = await context.store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: null,
    });
    if (prepared.status === "already_completed") {
      throw new MaintenanceAlreadyCompletedError(prepared.receipt);
    }
    if (prepared.maintenance.kind !== "creation") {
      throw new ManagedAgentSessionCreationError("prepared maintenance is not creation");
    }
    let active = prepared.maintenance;
    if (active.details.stagedRecord) {
      await context.store.finalizeMaintenance(
        agentSessionId,
        creationId,
        creationId,
        requestDigest,
        { save: active.details.stagedRecord },
      );
      const stored = active.details.stagedRecord;
      const audit = stored.auditLog
        ? await AuditPersistenceRuntime.resume({
            path: stored.auditLog.path,
            agentSessionId,
            auditLogId: stored.auditLog.auditLogId,
            generation: stored.auditLog.generation,
            writerLock: auditLogLock,
          })
        : undefined;
      lockTransferred = true;
      reportOpenProgress({ stage: "initializing" });
      const opened = active.details.stagedRecord.transcript
        ? await AgentSession.openManaged({
            ...runtimeConfig(config),
            agentSessionId,
            persistence: directPersistence(context.persistence, transcriptPath),
            checkpoint: active.details.stagedRecord.checkpoint,
          }, transcriptLock, audit, undefined, reportOpenProgress)
        : await AgentSession.openManagedRegistry({
            ...runtimeConfig(config),
            agentSessionId,
            persistence: directPersistence(context.persistence, null),
            checkpoint: active.details.stagedRecord.checkpoint,
          }, active.details.stagedRecord.internalSessionHistory, audit, undefined, reportOpenProgress);
      attachManagedRegistryPublisher(opened.session, context.store);
      reportOpenProgress({ stage: "ready", promptability: opened.session.promptability });
      return opened.session;
    }

    if (prepared.status === "already_prepared") {
      if (transcriptPath) {
        await removeOwnedCreationArtifact(
          transcriptPath, agentSessionId, creationId, requestDigest,
          context.persistence.limits.maxRecordBytes, "transcript",
        );
      }
      if (paths.auditLogPath) {
        await removeOwnedCreationArtifact(
          paths.auditLogPath, agentSessionId, creationId, requestDigest,
          context.persistence.limits.maxRecordBytes, "audit",
        );
      }
    }
    const stagedContinuation = active.details.stagedContinuation;
    lockTransferred = true;
    reportOpenProgress({ stage: "initializing" });
    session = await AgentSession.createManaged({
      ...runtimeConfig(config),
      agentSessionId,
      creationId,
      mode: "normal",
      providerSession: stagedContinuation?.internalSessionId
        ? { kind: "load", internalSessionId: stagedContinuation.internalSessionId, onFailure: "error" }
        : { kind: "new" },
      persistence: directPersistence(context.persistence, transcriptPath),
    }, {
      requestDigest,
      transcriptLock,
      auditLogLock,
      stageContinuation: async (state) => {
        const existing = active.details.stagedContinuation;
        if (existing) {
          if (existing.adapterId !== state.adapterId
            || existing.mode !== state.mode
            || existing.internalSessionId !== state.internalSessionId) {
            throw new ManagedAgentSessionCreationError(
              "loaded provider thread disagrees with staged continuation identity",
            );
          }
          return existing;
        }
        const update: CreationMaintenance = {
          ...active,
          details: { ...active.details, stagedContinuation: state },
        };
        await context.store.updateMaintenance(agentSessionId, creationId, creationId, update);
        active = update;
        return state;
      },
      onOpenProgress: reportOpenProgress,
    });

    const snapshot = session.getManagedPersistenceSnapshot();
    const record = initialRecord(
      config,
      context.persistence,
      active,
      snapshot,
    );
    const staged: CreationMaintenance = {
      ...active,
      details: { ...active.details, stagedRecord: record },
    };
    await context.store.updateMaintenance(agentSessionId, creationId, creationId, staged);
    await context.store.finalizeMaintenance(
      agentSessionId,
      creationId,
      creationId,
      requestDigest,
      { save: record },
    );
    attachManagedRegistryPublisher(session, context.store);
    reportOpenProgress({ stage: "ready", promptability: session.promptability });
    return session;
  } catch (error) {
    await session?.stop().catch(() => undefined);
    throw error;
  } finally {
    if (!lockTransferred) {
      await Promise.all([...acquired.values()].map((lock) => lock.release().catch(() => undefined)));
    }
  }
}

function runtimeConfig(config: ManagedAgentSessionCreateConfig): Omit<
  AgentSessionConfig,
  "agentSessionId" | "creationId" | "providerSession" | "persistence" | "mode"
> {
  const {
    agentSessionId: _agentSessionId,
    creationId: _creationId,
    persistence: _persistence,
    mode: _mode,
    onOpenProgress: _onOpenProgress,
    ...runtime
  } = config;
  return runtime;
}

function directPersistence(
  persistence: ResolvedAgentSessionPersistence,
  transcriptPath: string | null,
): AgentSessionPersistenceOptions {
  if (persistence.transcript !== false && !transcriptPath) {
    throw new ManagedAgentSessionCreationError("enabled transcript has no resolved path");
  }
  return {
    root: persistence.root,
    transcript: persistence.transcript === false ? false : {
      path: transcriptPath!,
      preset: persistence.transcript.preset,
      capture: persistence.transcript.capture,
      includeTruncationDigests: persistence.transcript.includeTruncationDigests,
    },
    auditLog: persistence.auditLog === false ? false : {
      path: persistence.auditLog.path,
      capture: persistence.auditLog.capture,
      includeTruncationDigests: persistence.auditLog.includeTruncationDigests,
    },
    sessionConfiguration: persistence.sessionConfiguration,
    limits: persistence.limits,
  };
}

function creationMaintenance(
  creationId: string,
  requestDigest: string,
  transcriptPath: string | null,
  auditLogPath: string | null,
): CreationMaintenance {
  return {
    kind: "creation",
    incarnationId: creationId,
    baseRecordRevision: null,
    operationId: creationId,
    requestDigest,
    status: "prepared",
    startedAt: new Date().toISOString(),
    details: { transcriptPath, auditLogPath },
  };
}

function initialRecord(
  config: ManagedAgentSessionCreateConfig,
  persistence: ResolvedAgentSessionPersistence,
  maintenance: CreationMaintenance,
  snapshot: ManagedAgentSessionPersistenceSnapshot,
): AgentSessionRecord {
  const { checkpoint, internalSessionHistory: history } = snapshot;
  if (persistence.transcript !== false && !checkpoint.transcript) {
    throw new ManagedAgentSessionCreationError("enabled transcript has no checkpoint identity");
  }
  return {
    agentSessionId: checkpoint.agentSessionId,
    incarnationId: checkpoint.incarnationId,
    recordRevision: 1,
    checkpoint,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    internalSessionId: checkpoint.internalSessionId,
    internalSessionActivatedAt: checkpoint.internalSessionActivatedAt,
    internalSessionHistory: history,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.title === undefined ? {} : { title: config.title }),
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    sessionConfigurationPersistence: persistence.sessionConfiguration,
    protocol: checkpoint.protocol,
    transcript: persistence.transcript === false ? null : {
      path: checkpoint.transcript!.path,
      transcriptId: checkpoint.transcript!.transcriptId,
      generation: checkpoint.transcript!.generation,
      preset: persistence.transcript.preset,
      effectivePolicy: persistence.transcript.capture,
      effectiveLimits: persistence.limits,
      includeTruncationDigests: persistence.transcript.includeTruncationDigests,
    },
    auditLog: snapshotAuditMetadata(persistence, snapshot),
    createdAt: maintenance.startedAt,
    updatedAt: checkpoint.updatedAt < maintenance.startedAt ? maintenance.startedAt : checkpoint.updatedAt,
    lastOpenedAt: checkpoint.updatedAt < maintenance.startedAt ? maintenance.startedAt : checkpoint.updatedAt,
  };
}

async function requireUninitializedDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) {
      throw new ManagedAgentSessionCreationError(`managed transcript destination is already initialized: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function removeOwnedCreationArtifact(
  path: string,
  agentSessionId: string,
  creationId: string,
  requestDigest: string,
  maxRecordBytes: number,
  kind: "transcript" | "audit",
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ManagedAgentSessionCreationError("prepared transcript artifact is not a regular file");
  }
  if (info.size === 0) return;
  const first = await firstJsonLine(path, maxRecordBytes);
  if (!isRecord(first)
    || first.v !== (kind === "transcript" ? 2 : 1)
    || first.t !== "header"
    || first.agentSessionId !== agentSessionId
    || !isRecord(first.installation)
    || first.installation.kind !== "creation"
    || first.installation.operationId !== creationId
    || first.installation.requestDigest !== requestDigest) {
    throw new ManagedAgentSessionCreationError(
      "prepared transcript artifact does not belong to this creation transaction",
    );
  }
  await unlink(path);
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function snapshotAuditMetadata(
  persistence: ResolvedAgentSessionPersistence,
  snapshot: ManagedAgentSessionPersistenceSnapshot,
): AgentSessionRecord["auditLog"] {
  if (persistence.auditLog === false) return null;
  const identity = snapshot?.auditLog;
  if (!identity) throw new ManagedAgentSessionCreationError("enabled audit log has no installed identity");
  return {
    path: identity.path,
    auditLogId: identity.auditLogId,
    generation: identity.generation,
    effectivePolicy: persistence.auditLog.capture,
    effectiveLimits: persistence.limits,
    includeTruncationDigests: persistence.auditLog.includeTruncationDigests,
  };
}

async function firstJsonLine(path: string, maxBytes: number): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const capacity = Math.min(maxBytes + 1, 16_777_217);
    const buffer = Buffer.alloc(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 || newline > maxBytes) {
      throw new ManagedAgentSessionCreationError("prepared transcript header exceeds its record limit");
    }
    return JSON.parse(buffer.subarray(0, newline).toString("utf8"));
  } catch (error) {
    if (error instanceof ManagedAgentSessionCreationError) throw error;
    throw new ManagedAgentSessionCreationError("prepared transcript header is malformed", { cause: error });
  } finally {
    await handle.close();
  }
}

function nonblankOrGenerated(value: string | undefined, label: string): string {
  if (value === undefined) return randomUUID();
  if (!value.trim()) throw new ManagedAgentSessionCreationError(`${label} cannot be blank`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
