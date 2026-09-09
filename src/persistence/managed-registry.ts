import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionCheckpoint } from "./checkpoint.ts";
import type { InternalSessionHistoryEntry } from "./records.ts";
import {
  AgentSessionStoreConflictError,
  type AgentSessionRecord,
  type AgentSessionStore,
} from "./registry.ts";

/** Materialize one authoritative checkpoint/history pair over an existing registry row. */
export function projectManagedAgentSessionRecord(
  current: AgentSessionRecord,
  checkpoint: AgentSessionCheckpoint,
  history: readonly InternalSessionHistoryEntry[],
  options: { readonly lastOpenedAt?: string } = {},
): AgentSessionRecord {
  if (current.agentSessionId !== checkpoint.agentSessionId
    || current.incarnationId !== checkpoint.incarnationId) {
    throw new AgentSessionStoreConflictError("managed registry projection identity mismatch");
  }
  const updatedAt = checkpoint.updatedAt < current.updatedAt ? current.updatedAt : checkpoint.updatedAt;
  return {
    ...current,
    recordRevision: current.recordRevision + 1,
    checkpoint,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    internalSessionId: checkpoint.internalSessionId,
    internalSessionActivatedAt: checkpoint.internalSessionActivatedAt,
    internalSessionHistory: history,
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    protocol: checkpoint.protocol,
    updatedAt,
    ...(options.lastOpenedAt === undefined
      ? {}
      : { lastOpenedAt: options.lastOpenedAt < updatedAt ? updatedAt : options.lastOpenedAt }),
  };
}

/** Attach ongoing transcript checkpoint publication to the strict managed store. */
export function attachManagedRegistryPublisher(
  session: AgentSession,
  store: AgentSessionStore,
): void {
  session.attachManagedCheckpointPublisher(async (checkpoint, history) => {
    const current = await store.getAgentSessionRecord(checkpoint.agentSessionId);
    if (!current || current.incarnationId !== checkpoint.incarnationId) {
      throw new AgentSessionStoreConflictError("managed registry projection identity disappeared");
    }
    const next = projectManagedAgentSessionRecord(current, checkpoint, history);
    await store.saveAgentSessionRecord(next, {
      expectedRecordRevision: current.recordRevision,
      expectedIncarnationId: current.incarnationId,
    });
  });
}
