import {
  AdapterMismatchError,
  AgentSession,
  type AgentSessionOpenConfig,
  type AgentSessionOpenResult,
} from "../agent-session.ts";
import type { AgentSessionPersistenceOptions } from "./config.ts";
import {
  AgentSessionStoreConflictError,
  SessionMaintenanceInProgressError,
  type AgentSessionRecord,
  type AgentSessionStore,
} from "./registry.ts";
import {
  attachManagedRegistryPublisher,
  projectManagedAgentSessionRecord,
} from "./managed-registry.ts";

export interface ManagedAgentSessionLoadConfig extends Omit<
  AgentSessionOpenConfig,
  "agentSessionId" | "persistence" | "checkpoint"
> {}

export class ManagedAgentSessionNotFoundError extends Error {
  constructor(readonly agentSessionId: string) {
    super(`managed agent session ${agentSessionId} was not found`);
    this.name = "ManagedAgentSessionNotFoundError";
  }
}

export class ManagedAgentSessionDeletedError extends Error {
  constructor(readonly agentSessionId: string) {
    super(`managed agent session ${agentSessionId} is deleted; restore it explicitly before loading`);
    this.name = "ManagedAgentSessionDeletedError";
  }
}

export class ManagedAgentSessionAuthorityConflictError extends AgentSessionStoreConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ManagedAgentSessionAuthorityConflictError";
  }
}

/** @internal Open one cataloged transcript authority and reconcile its registry projection. */
export async function loadManagedAgentSession(
  store: AgentSessionStore,
  agentSessionId: string,
  config: ManagedAgentSessionLoadConfig,
): Promise<AgentSessionOpenResult> {
  const [record, maintenance] = await Promise.all([
    store.getAgentSessionRecord(agentSessionId),
    store.getMaintenance(agentSessionId),
  ]);
  if (!record) throw new ManagedAgentSessionNotFoundError(agentSessionId);
  if (maintenance) throw new SessionMaintenanceInProgressError(agentSessionId);
  if (record.deletion) throw new ManagedAgentSessionDeletedError(agentSessionId);
  if (record.mode !== "normal") {
    throw new ManagedAgentSessionAuthorityConflictError("managed loading currently requires normal ACP mode");
  }
  if (record.auditLog) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "managed audit-log loading is not implemented yet",
    );
  }
  if (record.adapterId !== config.adapterId && !hasReconstructionStrategy(config)) {
    throw new AdapterMismatchError(record.adapterId, config.adapterId);
  }

  const opened = record.transcript
    ? await AgentSession.open({
        ...config,
        agentSessionId,
        persistence: persistenceFromManagedRecord(record),
      })
    : await AgentSession.openManagedRegistry({
        ...config,
        agentSessionId,
        checkpoint: record.checkpoint,
        persistence: {
          transcript: false,
          auditLog: false,
          sessionConfiguration: record.sessionConfigurationPersistence ?? { values: "typed" },
        },
      }, record.internalSessionHistory);
  try {
    const snapshot = opened.session.getManagedPersistenceSnapshot();
    assertCompatibleAuthority(record, snapshot.checkpoint);
    const current = await store.getAgentSessionRecord(agentSessionId);
    if (!current || current.incarnationId !== record.incarnationId) {
      throw new ManagedAgentSessionAuthorityConflictError(
        "managed registry identity changed while the transcript was opening",
      );
    }
    if (await store.getMaintenance(agentSessionId)) {
      throw new SessionMaintenanceInProgressError(agentSessionId);
    }
    assertCompatibleAuthority(current, snapshot.checkpoint);
    const openedAt = new Date().toISOString();
    const next = projectManagedAgentSessionRecord(
      current,
      snapshot.checkpoint,
      snapshot.internalSessionHistory,
      { lastOpenedAt: openedAt },
    );
    await store.saveAgentSessionRecord(next, {
      expectedRecordRevision: current.recordRevision,
      expectedIncarnationId: current.incarnationId,
    });
    attachManagedRegistryPublisher(opened.session, store);
    return opened;
  } catch (error) {
    await opened.session.stop().catch(() => undefined);
    throw error;
  }
}

export function persistenceFromManagedRecord(record: AgentSessionRecord): AgentSessionPersistenceOptions {
  if (!record.transcript) throw new ManagedAgentSessionAuthorityConflictError("transcript is unavailable");
  return {
    transcript: {
      path: record.transcript.path,
      preset: record.transcript.preset,
      capture: record.transcript.effectivePolicy,
      includeTruncationDigests: record.transcript.includeTruncationDigests,
    },
    auditLog: false,
    sessionConfiguration: record.sessionConfigurationPersistence ?? { values: "typed" },
    limits: record.transcript.effectiveLimits,
  };
}

function assertCompatibleAuthority(
  registry: AgentSessionRecord,
  transcript: AgentSessionRecord["checkpoint"],
): void {
  if (registry.agentSessionId !== transcript.agentSessionId
    || registry.incarnationId !== transcript.incarnationId) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry and transcript identify different logical session incarnations",
    );
  }
  if (registry.checkpoint.stateRevision > transcript.stateRevision) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry checkpoint is newer than transcript authority and cannot be reconciled",
    );
  }
  if (registry.checkpoint.stateRevision === transcript.stateRevision
    && registry.checkpoint.digest !== transcript.digest) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry and transcript checkpoints disagree at the same revision",
    );
  }
}

function hasReconstructionStrategy(config: ManagedAgentSessionLoadConfig): boolean {
  return config.continuation?.strategies?.some((strategy) => strategy.kind !== "load_internal_session") === true;
}
