import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSessionRecord, AgentSessionStore, DeletionMaintenance } from "./registry.ts";
import { AgentSessionStoreConflictError } from "./registry.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import { withSessionLogWriterLock } from "./session-log-writer.ts";

export interface DeleteAgentSessionOptions {
  /** Stable consumer-minted identity for retrying this exact deletion. */
  readonly deletionId: string;
  readonly expectedIncarnationId: string;
  readonly expectedRecordRevision: number;
  readonly deleteTranscript?: boolean;
  readonly deleteAuditLog?: boolean;
  readonly removeRegistryEntry?: boolean;
}

export class AgentSessionDeletionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionDeletionError";
  }
}

/** Execute the existing prepared-deletion transaction against one managed registry. */
export async function deleteManagedAgentSession(
  store: AgentSessionStore,
  agentSessionId: string,
  options: DeleteAgentSessionOptions,
): Promise<void> {
  const request = normalizeRequest(agentSessionId, options);
  const requestDigest = sha256CanonicalJson(request);
  const record = await store.getAgentSessionRecord(agentSessionId);

  // A hard-deletion retry can no longer derive artifact paths from a record. The store
  // checks the incarnation-scoped receipt before it examines this placeholder's details.
  if (!record) {
    const completed = await store.prepareMaintenance(
      agentSessionId,
      maintenance(request, requestDigest, null, null),
      { expectedRecordRevision: request.expectedRecordRevision },
    );
    if (completed.status === "already_completed") return;
    throw new AgentSessionStoreConflictError("agent-session record does not exist");
  }

  if (record.incarnationId !== request.expectedIncarnationId
    || record.recordRevision !== request.expectedRecordRevision) {
    throw new AgentSessionStoreConflictError("agent-session record compare-and-swap failed");
  }

  const transcriptPath = availableTranscriptPath(record);
  const auditLogPath = availableAuditLogPath(record);
  if (request.removeRegistryEntry
    && ((!request.deleteTranscript && transcriptPath !== null)
      || (!request.deleteAuditLog && auditLogPath !== null))) {
    throw new AgentSessionDeletionError(
      "removeRegistryEntry requires deletion of every retained transcript and audit log",
    );
  }

  const paths = [...new Set([transcriptPath, auditLogPath].filter((path): path is string => path !== null))]
    .sort((left, right) => left.localeCompare(right));
  await withOrderedLogLocks(paths, async () => {
    const proposed = maintenance(request, requestDigest, transcriptPath, auditLogPath);
    const prepared = await store.prepareMaintenance(agentSessionId, proposed, {
      expectedRecordRevision: request.expectedRecordRevision,
    });
    if (prepared.status === "already_completed") return;
    if (prepared.maintenance.kind !== "deletion") {
      throw new AgentSessionDeletionError("prepared maintenance is not a deletion");
    }
    const active = prepared.maintenance;

    if (active.details.deleteTranscript && active.details.transcriptPath) {
      await deleteAndSync(active.details.transcriptPath);
    }
    if (active.details.deleteAuditLog && active.details.auditLogPath) {
      await deleteAndSync(active.details.auditLogPath);
    }

    if (active.details.removeRegistryEntry) {
      await store.finalizeMaintenance(
        agentSessionId,
        request.expectedIncarnationId,
        request.deletionId,
        requestDigest,
        { deleteRecord: true },
      );
      return;
    }

    const mutationAt = active.startedAt < record.updatedAt ? record.updatedAt : active.startedAt;
    const deletedAt = record.deletion?.deletedAt ?? mutationAt;
    await store.finalizeMaintenance(
      agentSessionId,
      request.expectedIncarnationId,
      request.deletionId,
      requestDigest,
      {
        save: {
          ...record,
          recordRevision: record.recordRevision + 1,
          updatedAt: mutationAt,
          deletion: {
            deletedAt,
            ...(record.deletion?.transcriptDeletedAt === undefined
              && !(active.details.deleteTranscript && active.details.transcriptPath)
              ? {}
              : { transcriptDeletedAt: record.deletion?.transcriptDeletedAt ?? mutationAt }),
            ...(record.deletion?.auditLogDeletedAt === undefined
              && !(active.details.deleteAuditLog && active.details.auditLogPath)
              ? {}
              : { auditLogDeletedAt: record.deletion?.auditLogDeletedAt ?? mutationAt }),
          },
        },
      },
    );
  });
}

interface NormalizedDeletionRequest {
  readonly agentSessionId: string;
  readonly deletionId: string;
  readonly expectedIncarnationId: string;
  readonly expectedRecordRevision: number;
  readonly deleteTranscript: boolean;
  readonly deleteAuditLog: boolean;
  readonly removeRegistryEntry: boolean;
}

function normalizeRequest(
  agentSessionId: string,
  options: DeleteAgentSessionOptions,
): NormalizedDeletionRequest {
  for (const [label, value] of [
    ["agentSessionId", agentSessionId],
    ["deletionId", options?.deletionId],
    ["expectedIncarnationId", options?.expectedIncarnationId],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentSessionDeletionError(`${label} must be a nonblank string`);
    }
  }
  if (!Number.isSafeInteger(options.expectedRecordRevision) || options.expectedRecordRevision < 1) {
    throw new AgentSessionDeletionError("expectedRecordRevision must be a positive safe integer");
  }
  for (const field of ["deleteTranscript", "deleteAuditLog", "removeRegistryEntry"] as const) {
    if (options[field] !== undefined && typeof options[field] !== "boolean") {
      throw new AgentSessionDeletionError(`${field} must be boolean when provided`);
    }
  }
  return {
    agentSessionId,
    deletionId: options.deletionId,
    expectedIncarnationId: options.expectedIncarnationId,
    expectedRecordRevision: options.expectedRecordRevision,
    deleteTranscript: options.deleteTranscript ?? false,
    deleteAuditLog: options.deleteAuditLog ?? false,
    removeRegistryEntry: options.removeRegistryEntry ?? false,
  };
}

function maintenance(
  request: NormalizedDeletionRequest,
  requestDigest: string,
  transcriptPath: string | null,
  auditLogPath: string | null,
): DeletionMaintenance {
  return {
    kind: "deletion",
    incarnationId: request.expectedIncarnationId,
    baseRecordRevision: request.expectedRecordRevision,
    operationId: request.deletionId,
    requestDigest,
    status: "prepared",
    startedAt: new Date().toISOString(),
    details: {
      deleteTranscript: request.deleteTranscript,
      transcriptPath,
      deleteAuditLog: request.deleteAuditLog,
      auditLogPath,
      removeRegistryEntry: request.removeRegistryEntry,
    },
  };
}

function availableTranscriptPath(record: AgentSessionRecord): string | null {
  return record.transcript !== null && record.deletion?.transcriptDeletedAt === undefined
    ? record.transcript.path
    : null;
}

function availableAuditLogPath(record: AgentSessionRecord): string | null {
  return record.auditLog !== null && record.deletion?.auditLogDeletedAt === undefined
    ? record.auditLog.path
    : null;
}

async function withOrderedLogLocks<T>(
  paths: readonly string[],
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  const path = paths[index];
  if (path === undefined) return await operation();
  return await withSessionLogWriterLock(path, () => withOrderedLogLocks(paths, operation, index + 1));
}

async function deleteAndSync(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AgentSessionDeletionError(`could not delete session artifact: ${path}`, { cause: error });
    }
  }
  let parent;
  try {
    parent = await open(dirname(path), "r");
    await parent.sync();
  } catch (error) {
    throw new AgentSessionDeletionError(`could not synchronize deleted artifact directory: ${dirname(path)}`, { cause: error });
  } finally {
    await parent?.close().catch(() => undefined);
  }
}
