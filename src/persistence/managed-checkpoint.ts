import type { AgentSessionCheckpoint } from "./checkpoint.ts";
import {
  SessionMaintenanceInProgressError,
  type AgentSessionRecord,
  type AgentSessionStore,
} from "./registry.ts";
import { scanTranscriptContinuation } from "./transcript-scanner.ts";
import { ManagedAgentSessionAuthorityConflictError } from "./managed-load.ts";

export interface GetAgentSessionCheckpointOptions {
  readonly includeDeleted?: boolean;
  readonly source?: "resolved" | "registry_projection";
}

export interface ResolvedAgentSessionCheckpoint {
  readonly checkpoint: AgentSessionCheckpoint;
  readonly source: "transcript" | "registry_projection";
  readonly authoritative: boolean;
}

/** Resolve continuation authority without starting a harness or acquiring writer ownership. */
export async function getManagedAgentSessionCheckpoint(
  store: AgentSessionStore,
  agentSessionId: string,
  options: GetAgentSessionCheckpointOptions = {},
): Promise<ResolvedAgentSessionCheckpoint | null> {
  const [record, maintenance] = await Promise.all([
    store.getAgentSessionRecord(agentSessionId),
    store.getMaintenance(agentSessionId),
  ]);
  if (!record || (record.deletion && !options.includeDeleted)) return null;
  if (maintenance) throw new SessionMaintenanceInProgressError(agentSessionId);
  if (options.source === "registry_projection") {
    return frozen(record.checkpoint, "registry_projection", record.transcript === null);
  }
  if (!availableTranscript(record)) {
    return frozen(record.checkpoint, "registry_projection", record.transcript === null);
  }

  const scan = await scanTranscriptContinuation(record.transcript.path, {
    agentSessionId,
    transcriptId: record.transcript.transcriptId,
    generation: record.transcript.generation,
  });
  assertAuthority(record, scan.reduction.checkpoint);
  return frozen(scan.reduction.checkpoint, "transcript", true);
}

function availableTranscript(
  record: AgentSessionRecord,
): record is AgentSessionRecord & { readonly transcript: NonNullable<AgentSessionRecord["transcript"]> } {
  return record.transcript !== null && record.deletion?.transcriptDeletedAt === undefined;
}

function assertAuthority(record: AgentSessionRecord, checkpoint: AgentSessionCheckpoint): void {
  if (checkpoint.agentSessionId !== record.agentSessionId
    || checkpoint.incarnationId !== record.incarnationId) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry and transcript identify different logical session incarnations",
    );
  }
  if (record.checkpoint.stateRevision > checkpoint.stateRevision) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry checkpoint is newer than transcript authority and cannot be resolved offline",
    );
  }
  if (record.checkpoint.stateRevision === checkpoint.stateRevision
    && record.checkpoint.digest !== checkpoint.digest) {
    throw new ManagedAgentSessionAuthorityConflictError(
      "registry and transcript checkpoints disagree at the same revision",
    );
  }
}

function frozen(
  checkpoint: AgentSessionCheckpoint,
  source: ResolvedAgentSessionCheckpoint["source"],
  authoritative: boolean,
): ResolvedAgentSessionCheckpoint {
  return Object.freeze({ checkpoint: structuredClone(checkpoint), source, authoritative });
}
