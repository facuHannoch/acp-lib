import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AgentSession,
  type AgentSessionConfig,
} from "../agent-session.ts";
import type {
  AgentSessionPersistenceOptions,
  ManagedSessionPersistenceOptions,
  ResolvedAgentSessionPersistence,
} from "./config.ts";
import { resolveSessionLogPaths } from "./paths.ts";
import {
  AgentSessionStoreConflictError,
  type AgentSessionRecord,
  type AgentSessionStore,
  type CreationMaintenance,
  type MaintenanceCompletionReceipt,
} from "./registry.ts";
import type { InternalSessionHistoryEntry } from "./records.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import {
  acquireSessionLogWriterLock,
  type SessionLogWriterLock,
} from "./session-log-writer.ts";
import { attachManagedRegistryPublisher } from "./managed-registry.ts";

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
}

export class ManagedAgentSessionCreationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedAgentSessionCreationError";
  }
}

export class MaintenanceAlreadyCompletedError extends ManagedAgentSessionCreationError {
  constructor(readonly receipt: MaintenanceCompletionReceipt) {
    super(
      `managed ${receipt.kind} ${receipt.operationId} already completed; load the persisted session`,
    );
    this.name = "MaintenanceAlreadyCompletedError";
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
  if (context.persistence.auditLog !== false) {
    throw new ManagedAgentSessionCreationError(
      "managed audit-log creation is not implemented yet; disable auditLog for this session",
    );
  }
  const agentSessionId = nonblankOrGenerated(config.agentSessionId, "agentSessionId");
  const creationId = nonblankOrGenerated(config.creationId, "creationId");
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
  const proposed = creationMaintenance(
    creationId,
    requestDigest,
    transcriptPath,
  );

  // Completed retries are answered without touching the artifact or starting a harness.
  if (await context.store.getAgentSessionRecord(agentSessionId)) {
    const result = await context.store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: null,
    });
    if (result.status === "already_completed") throw new MaintenanceAlreadyCompletedError(result.receipt);
    throw new AgentSessionStoreConflictError("managed creation requires an unused logical identity");
  }

  if (transcriptPath) {
    await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(transcriptPath), 0o700).catch(() => undefined);
  }
  const transcriptLock = transcriptPath
    ? await acquireSessionLogWriterLock(transcriptPath)
    : undefined;
  let lockTransferred = false;
  let session: AgentSession | null = null;
  try {
    const priorMaintenance = await context.store.getMaintenance(agentSessionId);
    if (!priorMaintenance && transcriptPath) await requireUninitializedDestination(transcriptPath);
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
      await transcriptLock?.release();
      const opened = active.details.stagedRecord.transcript
        ? await AgentSession.open({
            ...runtimeConfig(config),
            agentSessionId,
            persistence: directPersistence(context.persistence, transcriptPath),
            checkpoint: active.details.stagedRecord.checkpoint,
          })
        : await AgentSession.openManagedRegistry({
            ...runtimeConfig(config),
            agentSessionId,
            persistence: directPersistence(context.persistence, null),
            checkpoint: active.details.stagedRecord.checkpoint,
          }, active.details.stagedRecord.internalSessionHistory);
      attachManagedRegistryPublisher(opened.session, context.store);
      return opened.session;
    }

    if (prepared.status === "already_prepared") {
      if (transcriptPath) {
        await removeOwnedCreationArtifact(
          transcriptPath, agentSessionId, creationId, requestDigest,
          context.persistence.limits.maxRecordBytes,
        );
      }
    }
    const stagedContinuation = active.details.stagedContinuation;
    lockTransferred = true;
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
    });

    const snapshot = session.getManagedPersistenceSnapshot();
    const record = initialRecord(
      config,
      context.persistence,
      active,
      snapshot.checkpoint,
      snapshot.internalSessionHistory,
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
    return session;
  } catch (error) {
    await session?.stop().catch(() => undefined);
    throw error;
  } finally {
    if (!lockTransferred) await transcriptLock?.release().catch(() => undefined);
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
    auditLog: false,
    sessionConfiguration: persistence.sessionConfiguration,
    limits: persistence.limits,
  };
}

function creationMaintenance(
  creationId: string,
  requestDigest: string,
  transcriptPath: string | null,
): CreationMaintenance {
  return {
    kind: "creation",
    incarnationId: creationId,
    baseRecordRevision: null,
    operationId: creationId,
    requestDigest,
    status: "prepared",
    startedAt: new Date().toISOString(),
    details: { transcriptPath, auditLogPath: null },
  };
}

function initialRecord(
  config: ManagedAgentSessionCreateConfig,
  persistence: ResolvedAgentSessionPersistence,
  maintenance: CreationMaintenance,
  checkpoint: AgentSessionRecord["checkpoint"],
  history: readonly InternalSessionHistoryEntry[],
): AgentSessionRecord {
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
    auditLog: null,
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
    || first.v !== 2
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
