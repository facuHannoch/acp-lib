import {
  createAgentSessionCheckpoint,
  type AgentSessionCheckpoint,
  type AgentSessionCheckpointInput,
} from "./checkpoint.ts";
import { canonicalizeJson, sha256CanonicalJson } from "./integrity.ts";
import {
  validateTranscriptRecord,
  type InternalSessionDescriptor,
  type InternalSessionHistoryEntry,
  type TranscriptCheckpointRecord,
  type TranscriptOperationRecord,
  type TranscriptTransitionRecord,
} from "./records.ts";

export type TranscriptStructuralRecord =
  | TranscriptCheckpointRecord
  | TranscriptOperationRecord
  | TranscriptTransitionRecord;

export interface TranscriptHistoryReduction {
  readonly entries: readonly InternalSessionHistoryEntry[];
  readonly revision: number;
  readonly digest: string;
}

export type SessionRecoveryStatus =
  | { readonly kind: "clean" }
  | {
      readonly kind: "uncertain";
      readonly operationId: string;
      readonly boundary:
        | "started_without_terminal"
        | "terminal_without_checkpoint"
        | "in_flight_checkpoint";
    };

export type PersistenceRepair =
  | {
      readonly kind: "aborted_checkpoint_rebuilt";
      readonly operationId: string;
      readonly stateRevision: number;
    }
  | {
      readonly kind: "activation_checkpoint_rebuilt";
      readonly transitionId: string;
      readonly stateRevision: number;
    }
  | {
      readonly kind: "registry_projection_repaired";
      readonly fromRevision: number;
      readonly toRevision: number;
    };

export interface TranscriptReductionResult {
  readonly checkpoint: AgentSessionCheckpoint;
  readonly internalSessionHistory: readonly InternalSessionHistoryEntry[];
  readonly recovery: SessionRecoveryStatus;
  readonly repairs: readonly PersistenceRepair[];
}

export class TranscriptReductionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptReductionError";
  }
}

const EMPTY_HISTORY_DIGEST = sha256CanonicalJson([]);

export function reduceTranscriptHistory(
  activationsThroughCheckpoint: Iterable<TranscriptTransitionRecord>,
): TranscriptHistoryReduction {
  const entries: InternalSessionHistoryEntry[] = [];
  let previousSequence = 0;
  let identity: { agentSessionId: string; transcriptId: string; generation: number } | null = null;
  let previousTarget: InternalSessionDescriptor | null = null;
  const transitionIds = new Set<string>();
  for (const record of activationsThroughCheckpoint) {
    validateStructuralRecord(record);
    if (record.event !== "target_activated") {
      throw new TranscriptReductionError("history fold accepts only target_activated records");
    }
    if (record.seq <= previousSequence) {
      throw new TranscriptReductionError("history activation records must be strictly sequence ordered");
    }
    if (!identity) {
      identity = {
        agentSessionId: record.agentSessionId,
        transcriptId: record.transcriptId,
        generation: record.generation,
      };
    } else if (record.agentSessionId !== identity.agentSessionId
      || record.transcriptId !== identity.transcriptId
      || record.generation !== identity.generation) {
      throw new TranscriptReductionError("history activation identity changed within one fold");
    }
    if (previousTarget && canonicalizeJson(record.from) !== canonicalizeJson(previousTarget)) {
      throw new TranscriptReductionError("history activation chain has a routing gap");
    }
    if (transitionIds.has(record.transitionId)) {
      throw new TranscriptReductionError(`transition ${record.transitionId} was activated more than once`);
    }
    transitionIds.add(record.transitionId);
    previousSequence = record.seq;
    if (record.historyEntry) entries.push(structuredClone(record.historyEntry));
    previousTarget = structuredClone(record.to!);
  }
  return historyResult(entries);
}

/** Apply the same canonical revision/digest algorithm to a registry or runtime history. */
export function reduceInternalSessionHistory(
  entries: readonly InternalSessionHistoryEntry[],
): TranscriptHistoryReduction {
  return historyResult(entries);
}

export function reduceTranscriptState(
  selectedCheckpointRecord: TranscriptCheckpointRecord,
  historyThroughCheckpoint: TranscriptHistoryReduction,
  structuralTailAfterCheckpointRecord: readonly TranscriptStructuralRecord[],
): TranscriptReductionResult {
  validateStructuralRecord(selectedCheckpointRecord);
  const selectedTranscript = selectedCheckpointRecord.checkpoint.transcript;
  if (!selectedTranscript) throw new TranscriptReductionError("selected transcript checkpoint has no transcript identity");
  const validatedHistory = historyResult(historyThroughCheckpoint.entries);
  if (historyThroughCheckpoint.revision !== validatedHistory.revision
    || historyThroughCheckpoint.digest !== validatedHistory.digest) {
    throw new TranscriptReductionError("supplied history reduction is internally inconsistent");
  }
  assertHistoryMatches(selectedCheckpointRecord.checkpoint, validatedHistory);

  let checkpoint = structuredClone(selectedCheckpointRecord.checkpoint);
  let history = validatedHistory.entries.map((entry) => structuredClone(entry));
  let previousSequence = selectedCheckpointRecord.seq;
  let active: ActiveOperation | null = checkpoint.boundary.status === "in_flight"
    ? {
        operationId: checkpoint.boundary.interruptedOperationId,
        checkpointed: true,
        terminal: null,
        terminalSequence: null,
      }
    : null;
  let pendingRepair: PendingRepair | null = null;
  const activatedTransitions = new Set(history.map((entry) => entry.transition.transitionId));

  for (const record of structuralTailAfterCheckpointRecord) {
    validateStructuralRecord(record);
    assertTailIdentity(record, selectedCheckpointRecord);
    if (record.seq <= previousSequence) {
      throw new TranscriptReductionError("structural tail must be strictly sequence ordered after the selected checkpoint record");
    }
    previousSequence = record.seq;

    if (record.t === "operation") {
      if (pendingRepair) {
        throw new TranscriptReductionError("a deterministic repair must be materialized before another operation boundary");
      }
      if (record.event === "started") {
        if (active) throw new TranscriptReductionError("a second operation started before the prior operation was checkpointed");
        checkpoint = deriveStartedCheckpoint(checkpoint, record);
        active = { operationId: record.operationId, checkpointed: false, terminal: null, terminalSequence: null };
        continue;
      }
      if (!active || active.operationId !== record.operationId) {
        throw new TranscriptReductionError(`terminal operation ${record.operationId} has no matching active operation`);
      }
      if (active.terminal) throw new TranscriptReductionError(`operation ${record.operationId} has more than one terminal record`);
      if (record.event === "aborted") {
        checkpoint = deriveAbortedCheckpoint(checkpoint, record);
        pendingRepair = {
          checkpoint,
          repair: {
            kind: "aborted_checkpoint_rebuilt",
            operationId: record.operationId,
            stateRevision: checkpoint.stateRevision,
          },
        };
        active = null;
      } else {
        active.terminal = record.event;
        active.terminalSequence = record.seq;
      }
      continue;
    }

    if (record.t === "transition") {
      if (record.event !== "target_activated") continue;
      if (active) throw new TranscriptReductionError("a transition target cannot activate during an uncheckpointed operation boundary");
      if (pendingRepair) throw new TranscriptReductionError("a transition target cannot activate before a prior repair is materialized");
      if (activatedTransitions.has(record.transitionId)) {
        throw new TranscriptReductionError(`transition ${record.transitionId} was activated more than once in the structural tail`);
      }
      activatedTransitions.add(record.transitionId);
      assertDescriptorMatchesCheckpoint(record.from, checkpoint);
      if (record.historyEntry) history.push(structuredClone(record.historyEntry));
      checkpoint = deriveActivationCheckpoint(checkpoint, record, historyResult(history));
      pendingRepair = {
        checkpoint,
        repair: {
          kind: "activation_checkpoint_rebuilt",
          transitionId: record.transitionId,
          stateRevision: checkpoint.stateRevision,
        },
      };
      continue;
    }

    const candidate = record.checkpoint;
    assertCheckpointIdentityStable(candidate, selectedCheckpointRecord.checkpoint);
    const candidateHistory = historyResult(history);
    assertHistoryMatches(candidate, candidateHistory);
    if (candidate.stateRevision < checkpoint.stateRevision) {
      throw new TranscriptReductionError("checkpoint stateRevision regressed");
    }
    const expectedRepair = pendingRepair;
    if (pendingRepair) {
      if (canonicalizeJson(candidate) !== canonicalizeJson(pendingRepair.checkpoint)) {
        throw new TranscriptReductionError("materialized checkpoint disagrees with deterministic reduction");
      }
      pendingRepair = null;
    }
    // A terminal checkpoint may fill in a thread slot the conversation never had. That is
    // the first attachment, not a routing change: nothing is superseded, so there is no
    // `from` descriptor to validate and no history entry to write.
    if (!expectedRepair) {
      assertRoutingStable(candidate, checkpoint, active?.terminal === "settled");
    }
    if (active) {
      if (active.terminal) {
        if (candidate.stateRevision <= checkpoint.stateRevision) {
          throw new TranscriptReductionError("terminal operation checkpoint must advance stateRevision");
        }
        assertTerminalCheckpoint(candidate, active);
        active = null;
      } else {
        assertInFlightCheckpoint(candidate, active.operationId);
        if (!active.checkpointed && canonicalizeJson(candidate) !== canonicalizeJson(checkpoint)) {
          throw new TranscriptReductionError("materialized in-flight checkpoint disagrees with started-operation reduction");
        }
        active.checkpointed = true;
      }
    } else if (!pendingRepair && candidate.stateRevision === checkpoint.stateRevision
      && canonicalizeJson(candidate) !== canonicalizeJson(checkpoint)) {
      throw new TranscriptReductionError("same-revision checkpoints disagree");
    }
    checkpoint = structuredClone(candidate);
  }

  const repairs = pendingRepair ? [pendingRepair.repair] : [];
  return {
    checkpoint,
    internalSessionHistory: history,
    recovery: recoveryStatus(checkpoint, active),
    repairs,
  };
}

interface ActiveOperation {
  operationId: string;
  checkpointed: boolean;
  terminal: Exclude<TranscriptOperationRecord["event"], "started" | "aborted"> | null;
  terminalSequence: number | null;
}

interface PendingRepair {
  checkpoint: AgentSessionCheckpoint;
  repair: Extract<PersistenceRepair, { kind: "aborted_checkpoint_rebuilt" | "activation_checkpoint_rebuilt" }>;
}

function deriveStartedCheckpoint(
  previous: AgentSessionCheckpoint,
  record: TranscriptOperationRecord,
): AgentSessionCheckpoint {
  if (record.stateRevision !== previous.stateRevision + 1) {
    throw new TranscriptReductionError("started operation stateRevision must follow the preceding checkpoint");
  }
  return rebuildCheckpoint(previous, {
    stateRevision: record.stateRevision,
    updatedAt: timestampToIso(record.ts),
    transcript: withCoveredSequence(previous, record.seq),
    boundary: {
      status: "in_flight",
      lastSettledOperationId: previous.boundary.lastSettledOperationId,
      interruptedOperationId: record.operationId,
      cause: "operation_started",
    },
  });
}

function deriveAbortedCheckpoint(
  previous: AgentSessionCheckpoint,
  record: TranscriptOperationRecord,
): AgentSessionCheckpoint {
  if (record.stateRevision !== previous.stateRevision + 1) {
    throw new TranscriptReductionError("aborted operation stateRevision must follow the preceding reduced checkpoint");
  }
  return rebuildCheckpoint(previous, {
    stateRevision: record.stateRevision,
    updatedAt: timestampToIso(record.ts),
    transcript: withCoveredSequence(previous, record.seq),
    boundary: { status: "settled", lastSettledOperationId: record.operationId },
  });
}

function deriveActivationCheckpoint(
  previous: AgentSessionCheckpoint,
  record: TranscriptTransitionRecord,
  reducedHistory: TranscriptHistoryReduction,
): AgentSessionCheckpoint {
  if (!record.to || !record.activationState) {
    throw new TranscriptReductionError("target activation lacks its deterministic state");
  }
  if (record.activationState.resultingStateRevision !== previous.stateRevision + 1) {
    throw new TranscriptReductionError("target activation stateRevision must follow the preceding checkpoint");
  }
  return rebuildCheckpoint(previous, {
    stateRevision: record.activationState.resultingStateRevision,
    adapterId: record.to.adapterId,
    mode: record.to.mode,
    internalSessionId: record.to.internalSessionId,
    internalSessionActivatedAt: record.to.activatedAt,
    internalSessionHistoryRevision: reducedHistory.revision,
    internalSessionHistoryDigest: reducedHistory.digest,
    lastTransition: {
      transitionId: record.transitionId,
      kind: record.kind,
      at: record.activationState.transitionAt,
    },
    model: record.to.model,
    sessionConfiguration: record.to.sessionConfiguration,
    protocol: record.to.protocol,
    transcript: withCoveredSequence(previous, record.seq),
    boundary: record.activationState.boundary,
    updatedAt: record.activationState.updatedAt,
  });
}

function rebuildCheckpoint(
  previous: AgentSessionCheckpoint,
  changes: Partial<AgentSessionCheckpointInput>,
): AgentSessionCheckpoint {
  const { version: _version, digest: _digest, ...body } = previous;
  return createAgentSessionCheckpoint({ ...body, ...structuredClone(changes) });
}

function withCoveredSequence(previous: AgentSessionCheckpoint, coveredSequence: number) {
  if (!previous.transcript) throw new TranscriptReductionError("cannot reduce transcript state without transcript identity");
  return { ...previous.transcript, coveredSequence };
}

function assertHistoryMatches(
  checkpoint: AgentSessionCheckpoint,
  history: TranscriptHistoryReduction,
): void {
  if (checkpoint.internalSessionHistoryRevision !== history.revision
    || checkpoint.internalSessionHistoryDigest !== history.digest) {
    throw new TranscriptReductionError("checkpoint history revision or digest disagrees with canonical transition history");
  }
}

function historyResult(entries: readonly InternalSessionHistoryEntry[]): TranscriptHistoryReduction {
  const detached = entries.map((entry) => structuredClone(entry));
  return {
    entries: detached,
    revision: detached.length,
    digest: detached.length === 0 ? EMPTY_HISTORY_DIGEST : sha256CanonicalJson(detached),
  };
}

function assertDescriptorMatchesCheckpoint(
  descriptor: InternalSessionDescriptor | null,
  checkpoint: AgentSessionCheckpoint,
): void {
  const current: InternalSessionDescriptor = {
    internalSessionId: checkpoint.internalSessionId,
    adapterId: checkpoint.adapterId,
    mode: checkpoint.mode,
    model: checkpoint.model,
    sessionConfiguration: checkpoint.sessionConfiguration,
    activatedAt: checkpoint.internalSessionActivatedAt,
    protocol: checkpoint.protocol,
  };
  if (descriptor === null) {
    if (checkpoint.internalSessionId === null) return;
    throw new TranscriptReductionError("transition from descriptor is absent for a current internal session");
  }
  if (canonicalizeJson(descriptor) !== canonicalizeJson(current)) {
    throw new TranscriptReductionError("transition from descriptor disagrees with current reduced state");
  }
}

function assertTerminalCheckpoint(checkpoint: AgentSessionCheckpoint, active: ActiveOperation): void {
  if (active.terminalSequence === null || checkpoint.transcript?.coveredSequence !== active.terminalSequence) {
    throw new TranscriptReductionError("terminal operation checkpoint must cover its terminal record");
  }
  if (checkpoint.boundary.status === "settled") {
    if (checkpoint.boundary.lastSettledOperationId !== active.operationId) {
      throw new TranscriptReductionError("settled terminal checkpoint does not name the operation");
    }
  } else if (checkpoint.boundary.interruptedOperationId !== active.operationId) {
    throw new TranscriptReductionError("terminal in-flight checkpoint names another operation");
  }
}

function assertInFlightCheckpoint(checkpoint: AgentSessionCheckpoint, operationId: string): void {
  if (checkpoint.boundary.status !== "in_flight"
    || checkpoint.boundary.interruptedOperationId !== operationId) {
    throw new TranscriptReductionError("checkpoint after a started operation must preserve its in-flight boundary");
  }
}

function assertCheckpointIdentityStable(
  candidate: AgentSessionCheckpoint,
  selected: AgentSessionCheckpoint,
): void {
  if (candidate.agentSessionId !== selected.agentSessionId
    || candidate.incarnationId !== selected.incarnationId
    || candidate.transcript?.transcriptId !== selected.transcript?.transcriptId
    || candidate.transcript?.generation !== selected.transcript?.generation
    || candidate.transcript?.path !== selected.transcript?.path) {
    throw new TranscriptReductionError("checkpoint identity changed within one transcript generation");
  }
}

function assertRoutingStable(
  candidate: AgentSessionCheckpoint,
  previous: AgentSessionCheckpoint,
  allowInitialAttachment = false,
): void {
  // A thread slot that was never filled can be filled by the checkpoint that settles the
  // turn justifying it. Replacing an already selected thread stays a transition.
  // The checkpoint constructor already refuses an id without its activation time, so
  // exempting both fields together cannot smuggle a half-formed attachment through.
  const attaching = allowInitialAttachment
    && previous.internalSessionId === null
    && candidate.internalSessionId !== null;
  const candidateRouting = {
    adapterId: candidate.adapterId,
    mode: candidate.mode,
    internalSessionId: attaching ? null : candidate.internalSessionId,
    internalSessionActivatedAt: attaching ? null : candidate.internalSessionActivatedAt,
    protocol: candidate.protocol,
    lastTransition: candidate.lastTransition ?? null,
  };
  const previousRouting = {
    adapterId: previous.adapterId,
    mode: previous.mode,
    internalSessionId: previous.internalSessionId,
    internalSessionActivatedAt: previous.internalSessionActivatedAt,
    protocol: previous.protocol,
    lastTransition: previous.lastTransition ?? null,
  };
  if (canonicalizeJson(candidateRouting) !== canonicalizeJson(previousRouting)) {
    throw new TranscriptReductionError("checkpoint changed routing without a target activation record");
  }
}

function recoveryStatus(
  checkpoint: AgentSessionCheckpoint,
  active: ActiveOperation | null,
): SessionRecoveryStatus {
  if (active?.terminal) {
    return { kind: "uncertain", operationId: active.operationId, boundary: "terminal_without_checkpoint" };
  }
  if (active) {
    return {
      kind: "uncertain",
      operationId: active.operationId,
      boundary: active.checkpointed ? "in_flight_checkpoint" : "started_without_terminal",
    };
  }
  if (checkpoint.boundary.status === "in_flight") {
    return {
      kind: "uncertain",
      operationId: checkpoint.boundary.interruptedOperationId,
      boundary: "in_flight_checkpoint",
    };
  }
  return { kind: "clean" };
}

function assertTailIdentity(
  record: TranscriptStructuralRecord,
  selected: TranscriptCheckpointRecord,
): void {
  if (record.agentSessionId !== selected.agentSessionId
    || record.transcriptId !== selected.transcriptId
    || record.generation !== selected.generation) {
    throw new TranscriptReductionError("structural tail identity disagrees with the selected checkpoint record");
  }
}

function validateStructuralRecord(record: TranscriptStructuralRecord): void {
  try {
    validateTranscriptRecord(record);
  } catch (error) {
    throw new TranscriptReductionError("invalid structural transcript record", { cause: error });
  }
}

function timestampToIso(value: number): string {
  try {
    return new Date(value).toISOString();
  } catch (error) {
    throw new TranscriptReductionError("operation timestamp is outside the ECMAScript ISO range", { cause: error });
  }
}

export { EMPTY_HISTORY_DIGEST };
