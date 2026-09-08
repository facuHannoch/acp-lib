import type {
  AuditLogCapturePolicy,
  PersistenceLimits,
  TranscriptCapturePolicy,
  TranscriptPreset,
} from "./config.ts";
import {
  validateAuditLogCapturePolicy,
  validatePersistenceLimits,
  validateTranscriptCapturePolicy,
} from "./config.ts";
import {
  validateAgentSessionCheckpoint,
  validateSessionConfigurationCheckpoint,
  type AgentSessionBoundary,
  type AgentSessionCheckpoint,
  type JsonObject,
  type JsonValue,
  type PersistedProtocol,
  type SessionConfigurationCheckpoint,
  type TransitionKind,
} from "./checkpoint.ts";
import {
  canonicalizeJson,
  isPersistedMachineCode,
  type PersistedMachineCode,
} from "./integrity.ts";

export type OperationKind =
  | "prompt"
  | "set_config"
  | "internal_session_command"
  | "handoff_summary"
  | "handoff_seed"
  | "switch_seed"
  | "other";

export type OperationEvent =
  | "started"
  | "settled"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "aborted";

export type OperationAbortReason =
  | "pre_dispatch_persistence_failure"
  | "pre_dispatch_cancelled";

export interface PersistedTruncation {
  readonly field: string;
  readonly reason: "field_limit" | "record_limit";
  readonly originalBytes: number;
  readonly originalSha256?: string;
}

export interface OmittedPersistedValue {
  readonly omitted: true;
  readonly reason: "field_limit" | "record_limit" | "max_depth";
  readonly originalBytes?: number;
  readonly originalSha256?: string;
}

export interface SessionLogInstallation {
  readonly kind: "creation" | "persistence_reconfiguration" | "restoration";
  readonly operationId: string;
  readonly requestDigest: string;
}

export interface InternalSessionHistoryTransition {
  readonly kind: TransitionKind;
  readonly transitionId: string;
  readonly reasonCode?: PersistedMachineCode;
}

export interface InternalSessionHistoryEntry {
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly model: string | null;
  readonly sessionConfiguration: SessionConfigurationCheckpoint;
  readonly protocol: PersistedProtocol;
  readonly activatedAt: string;
  readonly deactivatedAt: string;
  readonly transition: InternalSessionHistoryTransition;
}

export interface InternalSessionDescriptor {
  readonly internalSessionId: string | null;
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly model: string | null;
  readonly sessionConfiguration: SessionConfigurationCheckpoint;
  readonly activatedAt: string | null;
  readonly protocol: PersistedProtocol;
}

export type TranscriptRecordType =
  | "header"
  | "checkpoint"
  | "operation"
  | "message"
  | "reasoning"
  | "activity"
  | "configuration"
  | "permission"
  | "transition"
  | "metering_reference"
  | "lifecycle"
  | "protocol"
  | "raw";

export interface TranscriptEnvelope {
  readonly v: 2;
  readonly t: TranscriptRecordType;
  readonly transcriptId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly operationId?: string;
  readonly stateRevision?: number;
  readonly truncation?: readonly PersistedTruncation[];
}

export interface TranscriptHeaderRecord extends TranscriptEnvelope {
  readonly t: "header";
  readonly event: "created" | "upgraded" | "replaced";
  readonly createdAt: string;
  readonly preset: TranscriptPreset;
  readonly effectivePolicy: TranscriptCapturePolicy;
  readonly effectiveLimits: PersistenceLimits;
  readonly upgradedFrom?: { readonly version: 1; readonly boundaryOffset: number };
  readonly installation?: SessionLogInstallation;
}

export interface TranscriptCheckpointRecord extends TranscriptEnvelope {
  readonly t: "checkpoint";
  readonly stateRevision: number;
  readonly checkpoint: AgentSessionCheckpoint;
}

export interface TranscriptOperationRecord extends TranscriptEnvelope {
  readonly t: "operation";
  readonly event: OperationEvent;
  readonly operationId: string;
  readonly operationKind: OperationKind;
  readonly errorCode?: PersistedMachineCode;
  readonly abortReason?: OperationAbortReason;
}

export interface TranscriptResponseMessageV1 {
  readonly messageId?: string;
  readonly text: string;
}

export interface TranscriptStructuredMessagesV1 {
  readonly version: 1;
  readonly messages: readonly TranscriptResponseMessageV1[];
}

export interface TranscriptMessageRecord extends TranscriptEnvelope {
  readonly t: "message";
  readonly operationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly structured?: TranscriptStructuredMessagesV1;
  readonly status?: string;
  readonly stopReason?: string;
}

export interface TranscriptReasoningRecord extends TranscriptEnvelope {
  readonly t: "reasoning";
  readonly reasoningId: string;
  readonly reasoningRevision: number;
  readonly operationId: string;
  readonly text: string;
  readonly status: "in_progress" | "completed";
}

export interface TranscriptActivityRecord extends TranscriptEnvelope {
  readonly t: "activity";
  readonly activityId: string;
  readonly activityRevision: number;
  readonly operationId: string;
  readonly reason: "announced" | "input" | "settled" | "flushed" | "snapshot";
  readonly kind: string;
  readonly status?: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface TranscriptConfigurationRecord extends TranscriptEnvelope {
  readonly t: "configuration";
  readonly event: "announced" | "selected" | "restored" | "restore_failed" | "resolved";
  readonly configId?: string;
  readonly value?: JsonValue;
  readonly definitions?: JsonValue;
  readonly schemaDigest?: string;
}

export interface TranscriptPermissionRecord extends TranscriptEnvelope {
  readonly t: "permission";
  readonly permissionId: string;
  readonly activityId?: string;
  readonly event: "requested" | "resolved";
  readonly outcome?: string;
  readonly details?: JsonValue;
}

export interface TranscriptTransitionRecord extends TranscriptEnvelope {
  readonly t: "transition";
  readonly transitionId: string;
  readonly kind: TransitionKind;
  readonly event: "started" | "target_created" | "target_activated" | "completed" | "failed";
  readonly from: InternalSessionDescriptor | null;
  readonly to?: InternalSessionDescriptor;
  readonly historyEntry?: InternalSessionHistoryEntry;
  readonly activationState?: {
    readonly resultingStateRevision: number;
    readonly updatedAt: string;
    readonly transitionAt: string;
    readonly boundary: AgentSessionBoundary;
  };
  readonly failedAfter?: "start" | "target_created" | "target_activated";
  readonly summary?: string;
  readonly reasonCode?: PersistedMachineCode;
  readonly reasonText?: string;
  readonly errorCode?: PersistedMachineCode;
}

export interface TranscriptMeteringReferenceRecord extends TranscriptEnvelope {
  readonly t: "metering_reference";
  readonly operationId: string;
  readonly meteringRecordId: string;
  readonly status: "available" | "partial" | "unavailable";
  readonly summary?: JsonValue;
}

export interface TranscriptLifecycleRecord extends TranscriptEnvelope {
  readonly t: "lifecycle";
  readonly event:
    | "session_opened"
    | "stop_requested"
    | "session_stopped"
    | "transport_exited"
    | "recovery_required"
    | "recovery_resolved";
  readonly detail?: JsonValue;
}

export interface TranscriptProtocolMetadataRecord extends TranscriptEnvelope {
  readonly t: "protocol";
  readonly event: "initialized" | "capabilities_updated";
  readonly protocol: PersistedProtocol;
  readonly agent?: { readonly name?: string; readonly title?: string; readonly version?: string };
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface TranscriptRawRecord extends TranscriptEnvelope {
  readonly t: "raw";
  readonly protocol: string;
  readonly direction: "client_to_agent" | "agent_to_client";
  readonly event: string;
  readonly data: JsonValue;
}

export type KnownTranscriptRecord =
  | TranscriptHeaderRecord
  | TranscriptCheckpointRecord
  | TranscriptOperationRecord
  | TranscriptMessageRecord
  | TranscriptReasoningRecord
  | TranscriptActivityRecord
  | TranscriptConfigurationRecord
  | TranscriptPermissionRecord
  | TranscriptTransitionRecord
  | TranscriptMeteringReferenceRecord
  | TranscriptLifecycleRecord
  | TranscriptProtocolMetadataRecord
  | TranscriptRawRecord;

export interface UnknownTranscriptRecord {
  readonly v: number;
  readonly t: string;
  readonly transcriptId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly value: JsonObject;
}

export type AuditLogRecordType =
  | "header"
  | "operation"
  | "reasoning"
  | "activity"
  | "configuration"
  | "permission"
  | "transition"
  | "metering_reference"
  | "lifecycle";

export interface AuditLogEnvelope {
  readonly v: 1;
  readonly t: AuditLogRecordType;
  readonly auditLogId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly operationId?: string;
  readonly truncation?: readonly PersistedTruncation[];
}

export interface AuditLogHeaderRecord extends AuditLogEnvelope {
  readonly t: "header";
  readonly event: "created" | "replaced";
  readonly createdAt: string;
  readonly effectivePolicy: AuditLogCapturePolicy;
  readonly effectiveLimits: PersistenceLimits;
  readonly installation: SessionLogInstallation;
}

export interface AuditLogOperationRecord extends AuditLogEnvelope {
  readonly t: "operation";
  readonly event: OperationEvent;
  readonly operationId: string;
  readonly operationKind: OperationKind;
  readonly errorCode?: PersistedMachineCode;
  readonly abortReason?: OperationAbortReason;
}

export interface AuditLogReasoningRecord extends AuditLogEnvelope {
  readonly t: "reasoning";
  readonly reasoningId: string;
  readonly reasoningRevision: number;
  readonly operationId: string;
  readonly text: string;
  readonly status: "in_progress" | "completed";
}

export interface AuditLogActivityRecord extends AuditLogEnvelope {
  readonly t: "activity";
  readonly activityId: string;
  readonly activityRevision: number;
  readonly operationId: string;
  readonly reason: TranscriptActivityRecord["reason"];
  readonly kind: string;
  readonly status?: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface AuditLogConfigurationRecord extends AuditLogEnvelope {
  readonly t: "configuration";
  readonly event: TranscriptConfigurationRecord["event"];
  readonly configId?: string;
  readonly value?: JsonValue;
  readonly definitions?: JsonValue;
  readonly schemaDigest?: string;
}

export interface AuditLogPermissionRecord extends AuditLogEnvelope {
  readonly t: "permission";
  readonly permissionId: string;
  readonly activityId?: string;
  readonly event: "requested" | "resolved";
  readonly outcome?: string;
  readonly details?: JsonValue;
}

export type AuditInternalSessionDescriptor = Omit<InternalSessionDescriptor, "sessionConfiguration" | "activatedAt">;

export interface AuditLogTransitionRecord extends AuditLogEnvelope {
  readonly t: "transition";
  readonly transitionId: string;
  readonly kind: TransitionKind;
  readonly event: TranscriptTransitionRecord["event"];
  readonly from: AuditInternalSessionDescriptor | null;
  readonly to?: AuditInternalSessionDescriptor;
  readonly failedAfter?: "start" | "target_created" | "target_activated";
  readonly errorCode?: PersistedMachineCode;
  readonly reasonCode?: PersistedMachineCode;
}

export interface AuditLogMeteringReferenceRecord extends AuditLogEnvelope {
  readonly t: "metering_reference";
  readonly operationId: string;
  readonly meteringRecordId: string;
  readonly status: "available" | "partial" | "unavailable";
  readonly summary?: JsonValue;
}

export interface AuditLogLifecycleRecord extends AuditLogEnvelope {
  readonly t: "lifecycle";
  readonly event: TranscriptLifecycleRecord["event"];
  readonly detail?: JsonValue;
}

export type KnownAuditLogRecord =
  | AuditLogHeaderRecord
  | AuditLogOperationRecord
  | AuditLogReasoningRecord
  | AuditLogActivityRecord
  | AuditLogConfigurationRecord
  | AuditLogPermissionRecord
  | AuditLogTransitionRecord
  | AuditLogMeteringReferenceRecord
  | AuditLogLifecycleRecord;

export interface UnknownAuditLogRecord {
  readonly v: number;
  readonly t: string;
  readonly auditLogId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly value: JsonObject;
}

export interface SessionLogRecordExpectation {
  readonly agentSessionId?: string;
  readonly logId?: string;
  readonly generation?: number;
  /** Normalized path of the transcript currently being read. */
  readonly transcriptPath?: string;
}

export class SessionLogRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogRecordValidationError";
  }
}

export function validateTranscriptRecord(
  value: unknown,
  expected: SessionLogRecordExpectation = {},
): asserts value is KnownTranscriptRecord {
  const record = validateEnvelope(value, "transcript", expected);
  if (record.v !== 2) fail("unsupported transcript record version");
  if (!TRANSCRIPT_TYPES.has(record.t as string)) fail("unknown transcript record type");
  validateRecognizedRecord(record, "transcript", expected);
}

export function validateAuditLogRecord(
  value: unknown,
  expected: SessionLogRecordExpectation = {},
): asserts value is KnownAuditLogRecord {
  const record = validateEnvelope(value, "audit", expected);
  if (record.v !== 1) fail("unsupported audit-log record version");
  if (!AUDIT_TYPES.has(record.t as string)) fail("unknown audit-log record type");
  validateRecognizedRecord(record, "audit", expected);
}

const TRANSCRIPT_TYPES = new Set<string>([
  "header", "checkpoint", "operation", "message", "reasoning", "activity",
  "configuration", "permission", "transition", "metering_reference", "lifecycle",
  "protocol", "raw",
]);
const AUDIT_TYPES = new Set<string>([
  "header", "operation", "reasoning", "activity", "configuration", "permission",
  "transition", "metering_reference", "lifecycle",
]);

function validateEnvelope(
  value: unknown,
  sink: "transcript" | "audit",
  expected: SessionLogRecordExpectation,
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${sink} record must be an object`);
  // Reject non-JSON values and excessive nesting before any field is trusted.
  try {
    canonicalizeJson(value);
  } catch (error) {
    fail(`${sink} record is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  nonblank(value.t, "t");
  nonblank(value.agentSessionId, "agentSessionId");
  positiveInteger(value.generation, "generation");
  positiveInteger(value.seq, "seq");
  epochMilliseconds(value.ts, "ts");
  optionalNonblank(value.operationId, "operationId");
  if (value.stateRevision !== undefined) positiveInteger(value.stateRevision, "stateRevision");
  if (value.truncation !== undefined) validateTruncation(value.truncation);

  const idField = sink === "transcript" ? "transcriptId" : "auditLogId";
  nonblank(value[idField], idField);
  equalExpected(value.agentSessionId, expected.agentSessionId, "agentSessionId");
  equalExpected(value[idField], expected.logId, idField);
  equalExpected(value.generation, expected.generation, "generation");
  return value;
}

function validateRecognizedRecord(
  record: Record<string, unknown>,
  sink: "transcript" | "audit",
  expected: SessionLogRecordExpectation,
): void {
  switch (record.t) {
    case "header":
      validateHeader(record, sink);
      return;
    case "checkpoint":
      if (sink !== "transcript") fail("checkpoint is invalid audit content");
      validateCheckpointRecord(record, expected);
      return;
    case "operation":
      validateOperation(record);
      return;
    case "message":
      if (sink !== "transcript") fail("message is invalid audit content");
      requiredOperationId(record);
      if (record.role !== "user" && record.role !== "assistant") fail("message.role is invalid");
      if (typeof record.text !== "string") fail("message.text must be a string");
      if (record.structured !== undefined) validateStructuredMessages(record.structured);
      optionalString(record.status, "message.status");
      optionalString(record.stopReason, "message.stopReason");
      return;
    case "reasoning":
      requiredOperationId(record);
      nonblank(record.reasoningId, "reasoningId");
      positiveInteger(record.reasoningRevision, "reasoningRevision");
      if (typeof record.text !== "string") fail("reasoning.text must be a string");
      oneOf(record.status, ["in_progress", "completed"], "reasoning.status");
      return;
    case "activity":
      requiredOperationId(record);
      nonblank(record.activityId, "activityId");
      positiveInteger(record.activityRevision, "activityRevision");
      oneOf(record.reason, ["announced", "input", "settled", "flushed", "snapshot"], "activity.reason");
      nonblank(record.kind, "activity.kind");
      if (!isRecord(record.data)) fail("activity.data must be an object");
      return;
    case "configuration":
      oneOf(record.event, ["announced", "selected", "restored", "restore_failed", "resolved"], "configuration.event");
      optionalNonblank(record.configId, "configuration.configId");
      optionalSha256(record.schemaDigest, "configuration.schemaDigest");
      return;
    case "permission":
      nonblank(record.permissionId, "permissionId");
      optionalNonblank(record.activityId, "activityId");
      oneOf(record.event, ["requested", "resolved"], "permission.event");
      optionalString(record.outcome, "permission.outcome");
      return;
    case "transition":
      validateTransition(record, sink);
      return;
    case "metering_reference":
      requiredOperationId(record);
      nonblank(record.meteringRecordId, "meteringRecordId");
      oneOf(record.status, ["available", "partial", "unavailable"], "metering_reference.status");
      return;
    case "lifecycle":
      oneOf(record.event, ["session_opened", "stop_requested", "session_stopped", "transport_exited", "recovery_required", "recovery_resolved"], "lifecycle.event");
      return;
    case "protocol":
      if (sink !== "transcript") fail("protocol is invalid audit content");
      oneOf(record.event, ["initialized", "capabilities_updated"], "protocol.event");
      validateProtocol(record.protocol, "protocol.protocol");
      if (record.agent !== undefined) validateAgentIdentity(record.agent);
      if (!isRecord(record.capabilities) || Object.values(record.capabilities).some((item) => typeof item !== "boolean")) {
        fail("protocol.capabilities must contain only booleans");
      }
      if (!isLexicallySorted(Object.keys(record.capabilities))) {
        fail("protocol.capabilities keys must be lexically sorted");
      }
      return;
    case "raw":
      if (sink !== "transcript") fail("raw is invalid audit content");
      nonblank(record.protocol, "raw.protocol");
      oneOf(record.direction, ["client_to_agent", "agent_to_client"], "raw.direction");
      nonblank(record.event, "raw.event");
      if (!("data" in record)) fail("raw.data is required");
      return;
  }
  fail("unreachable record type");
}

function validateHeader(record: Record<string, unknown>, sink: "transcript" | "audit"): void {
  oneOf(record.event, sink === "transcript" ? ["created", "upgraded", "replaced"] : ["created", "replaced"], "header.event");
  iso(record.createdAt, "header.createdAt");
  if (!isRecord(record.effectivePolicy)) fail("header.effectivePolicy must be an object");
  if (!isRecord(record.effectiveLimits)) fail("header.effectiveLimits must be an object");
  try {
    validatePersistenceLimits(record.effectiveLimits as unknown as PersistenceLimits);
    if (sink === "transcript") {
      validateTranscriptCapturePolicy(record.effectivePolicy as unknown as TranscriptCapturePolicy);
    } else {
      validateAuditLogCapturePolicy(record.effectivePolicy as unknown as AuditLogCapturePolicy);
    }
  } catch (error) {
    fail(`header policy or limits are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sink === "transcript") {
    oneOf(record.preset, ["conversation", "activity", "detailed", "diagnostic"], "header.preset");
    if (record.event === "upgraded") {
      if (!isRecord(record.upgradedFrom) || record.upgradedFrom.version !== 1) fail("upgraded header requires upgradedFrom v1");
      nonnegativeInteger(record.upgradedFrom.boundaryOffset, "header.upgradedFrom.boundaryOffset");
      if (record.installation !== undefined) fail("upgraded header must not contain installation");
    } else {
      if (record.upgradedFrom !== undefined) fail("upgradedFrom is allowed only on upgraded headers");
      validateInstallation(record.installation, "header.installation");
    }
  } else {
    validateInstallation(record.installation, "header.installation");
  }
}

function validateCheckpointRecord(record: Record<string, unknown>, expected: SessionLogRecordExpectation): void {
  positiveInteger(record.stateRevision, "checkpoint.stateRevision");
  try {
    validateAgentSessionCheckpoint(record.checkpoint, {
      agentSessionId: record.agentSessionId as string,
      transcriptId: record.transcriptId as string,
      transcriptGeneration: record.generation as number,
      ...(expected.transcriptPath === undefined ? {} : { transcriptPath: expected.transcriptPath }),
    });
  } catch (error) {
    fail(`checkpoint payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checkpoint = record.checkpoint as AgentSessionCheckpoint;
  if (record.stateRevision !== checkpoint.stateRevision) fail("checkpoint record stateRevision mismatch");
  if (checkpoint.transcript === null) fail("transcript checkpoint record requires transcript identity");
  if (checkpoint.transcript.coveredSequence >= (record.seq as number)) {
    fail("checkpoint coveredSequence must precede its physical record");
  }
}

function validateOperation(record: Record<string, unknown>): void {
  requiredOperationId(record);
  oneOf(record.event, ["started", "settled", "failed", "cancelled", "interrupted", "aborted"], "operation.event");
  oneOf(record.operationKind, ["prompt", "set_config", "internal_session_command", "handoff_summary", "handoff_seed", "switch_seed", "other"], "operation.operationKind");
  optionalMachineCode(record.errorCode, "operation.errorCode");
  if (record.event === "aborted") {
    oneOf(record.abortReason, ["pre_dispatch_persistence_failure", "pre_dispatch_cancelled"], "operation.abortReason");
    if (record.errorCode !== undefined) fail("aborted operation cannot contain errorCode");
  } else if (record.abortReason !== undefined) {
    fail("operation.abortReason is allowed only for aborted events");
  }
  if (record.event === "started" || record.event === "aborted") {
    positiveInteger(record.stateRevision, "operation.stateRevision");
    epochMilliseconds(record.ts, "operation.ts");
  }
}

function validateTransition(record: Record<string, unknown>, sink: "transcript" | "audit"): void {
  nonblank(record.transitionId, "transitionId");
  oneOf(record.kind, ["handoff", "switch", "mode_change", "replacement"], "transition.kind");
  oneOf(record.event, ["started", "target_created", "target_activated", "completed", "failed"], "transition.event");
  if (record.from !== null && !isRecord(record.from)) fail("transition.from must be null or an object");
  if (record.to !== undefined && !isRecord(record.to)) fail("transition.to must be an object");
  if (isRecord(record.from)) validateSessionDescriptor(record.from, sink, "transition.from");
  if (isRecord(record.to)) validateSessionDescriptor(record.to, sink, "transition.to");
  optionalMachineCode(record.reasonCode, "transition.reasonCode");
  optionalMachineCode(record.errorCode, "transition.errorCode");
  if (record.event === "failed") {
    oneOf(record.failedAfter, ["start", "target_created", "target_activated"], "transition.failedAfter");
  } else if (record.failedAfter !== undefined) {
    fail("transition.failedAfter is allowed only for failed events");
  }
  if (sink === "audit") {
    for (const forbidden of ["sessionConfiguration", "historyEntry", "activationState", "summary", "reasonText"]) {
      if (record[forbidden] !== undefined) fail(`${forbidden} is invalid audit transition content`);
    }
    return;
  }
  if (record.event === "target_activated") {
    if (!isRecord(record.to)) fail("target_activated transition requires to");
    if (!isRecord(record.activationState)) fail("target_activated transition requires activationState");
    positiveInteger(record.activationState.resultingStateRevision, "transition.activationState.resultingStateRevision");
    iso(record.activationState.updatedAt, "transition.activationState.updatedAt");
    iso(record.activationState.transitionAt, "transition.activationState.transitionAt");
    validateBoundary(record.activationState.boundary, "transition.activationState.boundary");
    if (isRecord(record.from) && record.from.internalSessionId !== null) {
      validateHistoryEntry(record.historyEntry, record.from, record);
    } else if (record.historyEntry !== undefined) {
      fail("target_activated from a null internal session cannot contain historyEntry");
    }
  } else if (record.activationState !== undefined || record.historyEntry !== undefined) {
    fail("activationState and historyEntry are allowed only on target_activated");
  }
}

function validateHistoryEntry(
  value: unknown,
  from: Record<string, unknown>,
  transition: Record<string, unknown>,
): void {
  if (!isRecord(value)) fail("target_activated transition requires historyEntry for its prior internal session");
  nonblank(value.internalSessionId, "transition.historyEntry.internalSessionId");
  nonblank(value.adapterId, "transition.historyEntry.adapterId");
  if (value.model !== null) nonblank(value.model, "transition.historyEntry.model");
  validateProtocol(value.protocol, "transition.historyEntry.protocol");
  iso(value.activatedAt, "transition.historyEntry.activatedAt");
  iso(value.deactivatedAt, "transition.historyEntry.deactivatedAt");
  if (!isRecord(value.transition)) fail("transition.historyEntry.transition must be an object");
  if (value.transition.kind !== transition.kind || value.transition.transitionId !== transition.transitionId) {
    fail("transition.historyEntry transition identity mismatch");
  }
  optionalMachineCode(value.transition.reasonCode, "transition.historyEntry.transition.reasonCode");
  try {
    validateSessionConfigurationCheckpoint(value.sessionConfiguration, value.adapterId as string);
  } catch (error) {
    fail(`transition.historyEntry.sessionConfiguration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const comparableEntry = {
    internalSessionId: value.internalSessionId,
    adapterId: value.adapterId,
    model: value.model,
    sessionConfiguration: value.sessionConfiguration,
    protocol: value.protocol,
    activatedAt: value.activatedAt,
  };
  const comparableFrom = {
    internalSessionId: from.internalSessionId,
    adapterId: from.adapterId,
    model: from.model,
    sessionConfiguration: from.sessionConfiguration,
    protocol: from.protocol,
    activatedAt: from.activatedAt,
  };
  if (canonicalizeJson(comparableEntry) !== canonicalizeJson(comparableFrom)) {
    fail("transition.historyEntry does not match from descriptor");
  }
}

function validateBoundary(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (value.lastSettledOperationId !== null) nonblank(value.lastSettledOperationId, `${label}.lastSettledOperationId`);
  if (value.status === "settled") return;
  if (value.status !== "in_flight") fail(`${label}.status is invalid`);
  nonblank(value.interruptedOperationId, `${label}.interruptedOperationId`);
  oneOf(value.cause, ["operation_started", "transport_error", "harness_exit", "host_interrupt", "restored_after_unclean_exit"], `${label}.cause`);
}

function validateSessionDescriptor(
  value: Record<string, unknown>,
  sink: "transcript" | "audit",
  label: string,
): void {
  if (value.internalSessionId !== null) nonblank(value.internalSessionId, `${label}.internalSessionId`);
  nonblank(value.adapterId, `${label}.adapterId`);
  oneOf(value.mode, ["normal", "degraded"], `${label}.mode`);
  if (value.model !== null) nonblank(value.model, `${label}.model`);
  validateProtocol(value.protocol, `${label}.protocol`);
  if (sink === "audit") {
    if (value.sessionConfiguration !== undefined) fail("sessionConfiguration is invalid audit transition content");
    if (value.activatedAt !== undefined) fail("activatedAt is invalid audit transition content");
  } else {
    try {
      validateSessionConfigurationCheckpoint(value.sessionConfiguration, value.adapterId as string);
    } catch (error) {
      fail(`${label}.sessionConfiguration is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (value.activatedAt !== null) iso(value.activatedAt, `${label}.activatedAt`);
  }
}

function validateAgentIdentity(value: unknown): void {
  if (!isRecord(value)) fail("protocol.agent must be an object");
  optionalNonblank(value.name, "protocol.agent.name");
  optionalNonblank(value.title, "protocol.agent.title");
  optionalNonblank(value.version, "protocol.agent.version");
}

function validateStructuredMessages(value: unknown): void {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.messages)) {
    fail("message.structured must be a version-1 message collection");
  }
  for (const [index, message] of value.messages.entries()) {
    if (!isRecord(message) || typeof message.text !== "string") {
      fail(`message.structured.messages[${index}] is invalid`);
    }
    optionalNonblank(message.messageId, `message.structured.messages[${index}].messageId`);
  }
}

function validateInstallation(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`${label} must be an object`);
  oneOf(value.kind, ["creation", "persistence_reconfiguration", "restoration"], `${label}.kind`);
  nonblank(value.operationId, `${label}.operationId`);
  sha256(value.requestDigest, `${label}.requestDigest`);
}

function validateTruncation(value: unknown): void {
  if (!Array.isArray(value)) fail("truncation must be an array");
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) fail(`truncation[${index}] must be an object`);
    nonblank(item.field, `truncation[${index}].field`);
    oneOf(item.reason, ["field_limit", "record_limit"], `truncation[${index}].reason`);
    nonnegativeInteger(item.originalBytes, `truncation[${index}].originalBytes`);
    optionalSha256(item.originalSha256, `truncation[${index}].originalSha256`);
  }
}

function validateProtocol(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (value.name === "pty") return;
  if (value.name !== "acp") fail(`${label}.name is invalid`);
  positiveInteger(value.version, `${label}.version`);
}

function requiredOperationId(record: Record<string, unknown>): void {
  nonblank(record.operationId, "operationId");
}

function optionalMachineCode(value: unknown, label: string): void {
  if (value !== undefined && !isPersistedMachineCode(value)) fail(`${label} is invalid`);
}

function optionalSha256(value: unknown, label: string): void {
  if (value !== undefined) sha256(value, label);
}

function sha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be lowercase SHA-256`);
}

function nonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be nonblank`);
}

function optionalNonblank(value: unknown, label: string): void {
  if (value !== undefined) nonblank(value, label);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") fail(`${label} must be a string`);
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive safe integer`);
}

function nonnegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a nonnegative safe integer`);
}

function epochMilliseconds(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value as number).valueOf())) {
    fail(`${label} must be safe Unix epoch milliseconds in the ECMAScript date range`);
  }
}

function iso(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be canonical ISO-8601`);
  }
}

function oneOf(value: unknown, choices: readonly string[], label: string): void {
  if (typeof value !== "string" || !choices.includes(value)) fail(`${label} is invalid`);
}

function isLexicallySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) <= 0);
}

function equalExpected(actual: unknown, expected: unknown, label: string): void {
  if (expected !== undefined && actual !== expected) fail(`${label} mismatch`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new SessionLogRecordValidationError(message);
}
