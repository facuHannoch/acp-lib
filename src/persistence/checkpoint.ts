import { isAbsolute } from "node:path";
import {
  restoreMeteringState,
  type AgentSessionMeteringState,
} from "../metering/state.ts";
import { checkpointDigest, checkpointDigestMatches, PersistenceSerializationError } from "./integrity.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type TransitionKind = "handoff" | "switch" | "mode_change" | "replacement";
export type PersistedProtocol = { name: "acp"; version: number } | { name: "pty" };

export interface PersistedSessionConfigSelection {
  readonly configId: string;
  readonly type: "select" | "boolean" | "unknown";
  readonly value: JsonValue;
  readonly ordinal: number;
  readonly source: "explicit_selection" | "accepted_effective";
  readonly recordedAt: string;
}

export interface SessionConfigurationCheckpoint {
  readonly adapterId: string;
  readonly schemaDigest: string | null;
  readonly announcedConfigIds: readonly string[];
  readonly restorationTargets: readonly PersistedSessionConfigSelection[];
  readonly effective: Readonly<Record<string, JsonValue>>;
  readonly omittedConfigIds: readonly string[];
  readonly restorationFidelity: "exact" | "partial";
  readonly observedAt: string;
}

export type AgentSessionBoundary =
  | { readonly status: "settled"; readonly lastSettledOperationId: string | null }
  | {
      readonly status: "in_flight";
      readonly lastSettledOperationId: string | null;
      readonly interruptedOperationId: string;
      readonly cause:
        | "operation_started"
        | "transport_error"
        | "harness_exit"
        | "host_interrupt"
        | "restored_after_unclean_exit";
    };

export interface AgentSessionCheckpoint {
  readonly version: 1;
  readonly agentSessionId: string;
  readonly incarnationId: string;
  readonly stateRevision: number;
  readonly digest: string;
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly internalSessionId: string | null;
  readonly internalSessionActivatedAt: string | null;
  readonly internalSessionHistoryRevision: number;
  readonly internalSessionHistoryDigest: string;
  readonly lastTransition?: {
    readonly transitionId: string;
    readonly kind: TransitionKind;
    readonly at: string;
  };
  readonly model: string | null;
  readonly sessionConfiguration: SessionConfigurationCheckpoint;
  readonly protocol: PersistedProtocol;
  readonly transcript: null | {
    readonly transcriptId: string;
    readonly generation: number;
    readonly path: string;
    readonly coveredSequence: number;
  };
  readonly metering?: AgentSessionMeteringState;
  readonly boundary: AgentSessionBoundary;
  readonly updatedAt: string;
}

export type AgentSessionCheckpointInput = Omit<AgentSessionCheckpoint, "version" | "digest">;

export interface CheckpointIdentityExpectation {
  readonly agentSessionId?: string;
  readonly incarnationId?: string;
  readonly adapterId?: string;
  readonly transcriptId?: string;
  readonly transcriptGeneration?: number;
  readonly transcriptPath?: string;
}

export class CheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointValidationError";
  }
}

export function createAgentSessionCheckpoint(
  input: AgentSessionCheckpointInput,
): AgentSessionCheckpoint {
  const withoutDigest = { version: 1 as const, ...structuredClone(input) };
  const checkpoint = {
    ...withoutDigest,
    digest: checkpointDigest(withoutDigest as unknown as Record<string, unknown>),
  };
  validateAgentSessionCheckpoint(checkpoint);
  return checkpoint;
}

export function validateAgentSessionCheckpoint(
  value: unknown,
  expected: CheckpointIdentityExpectation = {},
): asserts value is AgentSessionCheckpoint {
  if (!isRecord(value)) throw new CheckpointValidationError("checkpoint must be an object");
  if (value.version !== 1) throw new CheckpointValidationError("unsupported checkpoint version");
  nonblank(value.agentSessionId, "agentSessionId");
  nonblank(value.incarnationId, "incarnationId");
  nonblank(value.adapterId, "adapterId");
  if (value.mode !== "normal" && value.mode !== "degraded") {
    throw new CheckpointValidationError("mode is invalid");
  }
  positiveInteger(value.stateRevision, "stateRevision");
  nonnegativeInteger(value.internalSessionHistoryRevision, "internalSessionHistoryRevision");
  sha256(value.internalSessionHistoryDigest, "internalSessionHistoryDigest");
  nullableNonblank(value.internalSessionId, "internalSessionId");
  nullableIso(value.internalSessionActivatedAt, "internalSessionActivatedAt");
  nullableNonblank(value.model, "model");
  iso(value.updatedAt, "updatedAt");
  validateProtocol(value.protocol);
  validateBoundary(value.boundary);
  validateSessionConfigurationCheckpoint(value.sessionConfiguration, value.adapterId as string);
  validateTranscript(value.transcript);
  validateLastTransition(value.lastTransition);
  validateMetering(value.metering, value.agentSessionId as string);

  if ((value.internalSessionId === null) !== (value.internalSessionActivatedAt === null)) {
    throw new CheckpointValidationError(
      "internalSessionId and internalSessionActivatedAt must both be null or both be present",
    );
  }
  if (typeof value.internalSessionActivatedAt === "string") {
    timestampNotAfter(value.internalSessionActivatedAt, value.updatedAt as string, "internalSessionActivatedAt");
  }
  if (isRecord(value.lastTransition)) {
    timestampNotAfter(value.lastTransition.at as string, value.updatedAt as string, "lastTransition.at");
  }

  try {
    if (!checkpointDigestMatches(value)) throw new CheckpointValidationError("checkpoint digest mismatch");
  } catch (error) {
    if (error instanceof CheckpointValidationError) throw error;
    if (error instanceof PersistenceSerializationError) {
      throw new CheckpointValidationError(`checkpoint is not canonical JSON: ${error.message}`);
    }
    throw error;
  }

  equalExpected(value.agentSessionId, expected.agentSessionId, "agentSessionId");
  equalExpected(value.incarnationId, expected.incarnationId, "incarnationId");
  equalExpected(value.adapterId, expected.adapterId, "adapterId");
  if (expected.transcriptId !== undefined || expected.transcriptGeneration !== undefined || expected.transcriptPath !== undefined) {
    if (!isRecord(value.transcript)) throw new CheckpointValidationError("checkpoint has no transcript identity");
    equalExpected(value.transcript.transcriptId, expected.transcriptId, "transcriptId");
    equalExpected(value.transcript.generation, expected.transcriptGeneration, "transcript generation");
    equalExpected(value.transcript.path, expected.transcriptPath, "transcript path");
  }
}

export function validateSessionConfigurationCheckpoint(value: unknown, adapterId: string): asserts value is SessionConfigurationCheckpoint {
  if (!isRecord(value)) throw new CheckpointValidationError("sessionConfiguration must be an object");
  if (value.adapterId !== adapterId) throw new CheckpointValidationError("sessionConfiguration adapterId mismatch");
  if (value.schemaDigest !== null) sha256(value.schemaDigest, "sessionConfiguration.schemaDigest");
  uniqueStringArray(value.announcedConfigIds, "sessionConfiguration.announcedConfigIds");
  uniqueStringArray(value.omittedConfigIds, "sessionConfiguration.omittedConfigIds");
  if (!Array.isArray(value.restorationTargets)) throw new CheckpointValidationError("sessionConfiguration.restorationTargets must be an array");
  if (!isRecord(value.effective)) throw new CheckpointValidationError("sessionConfiguration.effective must be an object");
  if (value.restorationFidelity !== "exact" && value.restorationFidelity !== "partial") throw new CheckpointValidationError("sessionConfiguration.restorationFidelity is invalid");
  iso(value.observedAt, "sessionConfiguration.observedAt");

  const targetIds = new Set<string>();
  let previousOrdinal = -1;
  for (const [index, target] of value.restorationTargets.entries()) {
    if (!isRecord(target)) {
      throw new CheckpointValidationError(`sessionConfiguration.restorationTargets[${index}] must be an object`);
    }
    nonblank(target.configId, `sessionConfiguration.restorationTargets[${index}].configId`);
    if (targetIds.has(target.configId)) {
      throw new CheckpointValidationError("sessionConfiguration.restorationTargets contains duplicate configId");
    }
    targetIds.add(target.configId);
    if (!(["select", "boolean", "unknown"] as unknown[]).includes(target.type)) {
      throw new CheckpointValidationError(`sessionConfiguration.restorationTargets[${index}].type is invalid`);
    }
    nonnegativeInteger(target.ordinal, `sessionConfiguration.restorationTargets[${index}].ordinal`);
    if ((target.ordinal as number) <= previousOrdinal) {
      throw new CheckpointValidationError("sessionConfiguration.restorationTargets ordinals must be strictly increasing");
    }
    previousOrdinal = target.ordinal as number;
    if (target.source !== "explicit_selection" && target.source !== "accepted_effective") {
      throw new CheckpointValidationError(`sessionConfiguration.restorationTargets[${index}].source is invalid`);
    }
    iso(target.recordedAt, `sessionConfiguration.restorationTargets[${index}].recordedAt`);
  }

  const announced = new Set(value.announcedConfigIds as string[]);
  for (const omitted of value.omittedConfigIds as string[]) {
    if (!announced.has(omitted)) {
      throw new CheckpointValidationError("sessionConfiguration.omittedConfigIds must be announced");
    }
  }
  if (value.restorationFidelity === "exact" && (value.omittedConfigIds as string[]).length > 0) {
    throw new CheckpointValidationError("exact session configuration cannot contain omittedConfigIds");
  }
}

function validateMetering(value: unknown, agentSessionId: string): void {
  if (value === undefined) return;
  const restored = restoreMeteringState(value as AgentSessionMeteringState, agentSessionId);
  if (restored.status !== "restored") {
    const reason = restored.status === "ignored" ? restored.reason : "initial_state_missing";
    throw new CheckpointValidationError(`metering state is invalid: ${reason}`);
  }
}

function validateTranscript(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value)) throw new CheckpointValidationError("transcript must be null or an object");
  nonblank(value.transcriptId, "transcript.transcriptId");
  positiveInteger(value.generation, "transcript.generation");
  if (typeof value.path !== "string" || !isAbsolute(value.path)) throw new CheckpointValidationError("transcript.path must be absolute");
  nonnegativeInteger(value.coveredSequence, "transcript.coveredSequence");
}

function validateProtocol(value: unknown): void {
  if (!isRecord(value)) throw new CheckpointValidationError("protocol must be an object");
  if (value.name === "pty") return;
  if (value.name !== "acp") throw new CheckpointValidationError("protocol.name is invalid");
  positiveInteger(value.version, "protocol.version");
}

function validateBoundary(value: unknown): void {
  if (!isRecord(value)) throw new CheckpointValidationError("boundary must be an object");
  nullableNonblank(value.lastSettledOperationId, "boundary.lastSettledOperationId");
  if (value.status === "settled") return;
  if (value.status !== "in_flight") throw new CheckpointValidationError("boundary.status is invalid");
  nonblank(value.interruptedOperationId, "boundary.interruptedOperationId");
  if (!["operation_started", "transport_error", "harness_exit", "host_interrupt", "restored_after_unclean_exit"].includes(value.cause as string)) {
    throw new CheckpointValidationError("boundary.cause is invalid");
  }
}

function validateLastTransition(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new CheckpointValidationError("lastTransition must be an object");
  nonblank(value.transitionId, "lastTransition.transitionId");
  if (!["handoff", "switch", "mode_change", "replacement"].includes(value.kind as string)) throw new CheckpointValidationError("lastTransition.kind is invalid");
  iso(value.at, "lastTransition.at");
}

function equalExpected(actual: unknown, expected: unknown, label: string): void {
  if (expected !== undefined && actual !== expected) throw new CheckpointValidationError(`${label} mismatch`);
}

function nonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new CheckpointValidationError(`${label} must be nonblank`);
}

function nullableNonblank(value: unknown, label: string): void {
  if (value !== null) nonblank(value, label);
}

function uniqueStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new CheckpointValidationError(`${label} must contain nonblank strings`);
  if (new Set(value).size !== value.length) throw new CheckpointValidationError(`${label} must not contain duplicates`);
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CheckpointValidationError(`${label} must be a positive safe integer`);
}

function nonnegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CheckpointValidationError(`${label} must be a nonnegative safe integer`);
}

function sha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new CheckpointValidationError(`${label} must be lowercase SHA-256`);
}

function nullableIso(value: unknown, label: string): void {
  if (value !== null) iso(value, label);
}

function iso(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new CheckpointValidationError(`${label} must be canonical ISO-8601`);
}

function timestampNotAfter(value: string, upperBound: string, label: string): void {
  if (Date.parse(value) > Date.parse(upperBound)) {
    throw new CheckpointValidationError(`${label} must not be after updatedAt`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
