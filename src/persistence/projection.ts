import type {
  AuditLogCapturePolicy,
  TranscriptCapturePolicy,
} from "./config.ts";
import type {
  AgentSessionCheckpoint,
  JsonObject,
  JsonValue,
  PersistedProtocol,
} from "./checkpoint.ts";
import type {
  AuditInternalSessionDescriptor,
  AuditLogActivityRecord,
  AuditLogEnvelope,
  KnownAuditLogRecord,
  KnownTranscriptRecord,
  OperationAbortReason,
  OperationEvent,
  OperationKind,
  TranscriptActivityRecord,
  TranscriptEnvelope,
  TranscriptLifecycleRecord,
  TranscriptTransitionRecord,
  InternalSessionDescriptor,
  InternalSessionHistoryEntry,
} from "./records.ts";
import type { PersistedMachineCode } from "./integrity.ts";

export interface TranscriptProjectionContext {
  readonly transcriptId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly policy: TranscriptCapturePolicy;
}

export interface AuditProjectionContext {
  readonly auditLogId: string;
  readonly generation: number;
  readonly agentSessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly policy: AuditLogCapturePolicy;
}

export interface NormalizedActivityProjection {
  readonly activityId: string;
  readonly activityRevision: number;
  readonly operationId: string;
  readonly reason: TranscriptActivityRecord["reason"];
  readonly kind: string;
  readonly status?: string;
  /** Content-free allowlist. Titles are intentionally absent because agents derive them from arguments. */
  readonly metadata?: {
    readonly providerActivityId?: string;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly durationMs?: number;
  };
  /** Invocation arguments, commands, paths, and patches. */
  readonly input?: JsonObject;
  /** Tool results, output, and returned content. */
  readonly content?: JsonObject;
}

export type NormalizedPersistenceEvent =
  | {
      readonly kind: "operation";
      readonly event: OperationEvent;
      readonly operationId: string;
      readonly operationKind: OperationKind;
      readonly stateRevision?: number;
      readonly errorCode?: PersistedMachineCode;
      readonly abortReason?: OperationAbortReason;
    }
  | { readonly kind: "checkpoint"; readonly checkpoint: AgentSessionCheckpoint }
  | {
      readonly kind: "message";
      readonly operationId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly structured?: { readonly version: 1; readonly messages: readonly { readonly messageId?: string; readonly text: string }[] };
      readonly status?: string;
      readonly stopReason?: string;
    }
  | {
      readonly kind: "reasoning";
      readonly reasoningId: string;
      readonly reasoningRevision: number;
      readonly operationId: string;
      readonly text: string;
      readonly status: "in_progress" | "completed";
    }
  | { readonly kind: "activity"; readonly activity: NormalizedActivityProjection }
  | {
      readonly kind: "configuration";
      readonly event: "announced" | "selected" | "restored" | "restore_failed" | "resolved";
      readonly configId?: string;
      readonly value?: JsonValue;
      readonly definitions?: JsonValue;
      readonly schemaDigest?: string;
    }
  | {
      readonly kind: "permission";
      readonly permissionId: string;
      readonly activityId?: string;
      readonly event: "requested" | "resolved";
      readonly outcome?: string;
      readonly fullDetails?: JsonValue;
    }
  | {
      readonly kind: "transition";
      readonly transitionId: string;
      readonly transitionKind: TranscriptTransitionRecord["kind"];
      readonly event: TranscriptTransitionRecord["event"];
      readonly from: InternalSessionDescriptor | null;
      readonly to?: InternalSessionDescriptor;
      readonly historyEntry?: InternalSessionHistoryEntry;
      readonly activationState?: TranscriptTransitionRecord["activationState"];
      readonly failedAfter?: TranscriptTransitionRecord["failedAfter"];
      readonly summary?: string;
      readonly reasonCode?: PersistedMachineCode;
      readonly reasonText?: string;
      readonly errorCode?: PersistedMachineCode;
    }
  | {
      readonly kind: "metering_reference";
      readonly operationId: string;
      readonly meteringRecordId: string;
      readonly status: "available" | "partial" | "unavailable";
      readonly summary?: JsonValue;
    }
  | { readonly kind: "lifecycle"; readonly event: TranscriptLifecycleRecord["event"]; readonly detail?: JsonValue }
  | {
      readonly kind: "protocol_metadata";
      readonly event: "initialized" | "capabilities_updated";
      readonly protocol: PersistedProtocol;
      readonly agent?: { readonly name?: string; readonly title?: string; readonly version?: string };
      readonly capabilities: Readonly<Record<string, boolean>>;
    }
  | {
      readonly kind: "raw_protocol";
      readonly protocol: string;
      readonly direction: "client_to_agent" | "agent_to_client";
      readonly event: string;
      readonly data: JsonValue;
    };

export function projectTranscriptEvent(
  event: NormalizedPersistenceEvent,
  context: TranscriptProjectionContext,
): KnownTranscriptRecord | null {
  const base = transcriptEnvelope(context);
  switch (event.kind) {
    case "operation":
      return {
        ...base, t: "operation", event: event.event, operationId: event.operationId,
        operationKind: event.operationKind,
        ...(event.stateRevision === undefined ? {} : { stateRevision: event.stateRevision }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.abortReason === undefined ? {} : { abortReason: event.abortReason }),
      };
    case "checkpoint":
      return { ...base, t: "checkpoint", stateRevision: event.checkpoint.stateRevision, checkpoint: structuredClone(event.checkpoint) };
    case "message":
      if (context.policy.messages === "none") return null;
      return {
        ...base, t: "message", operationId: event.operationId, role: event.role, text: event.text,
        ...(event.structured === undefined ? {} : { structured: structuredClone(event.structured) }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
      };
    case "reasoning":
      if (context.policy.reasoning === "none") return null;
      return { ...base, t: "reasoning", reasoningId: event.reasoningId, reasoningRevision: event.reasoningRevision, operationId: event.operationId, text: event.text, status: event.status };
    case "activity": {
      const data = activityData(event.activity, context.policy.tools);
      if (!data) return null;
      return activityRecord(base, event.activity, data);
    }
    case "configuration": {
      const projected = configurationData(event, context.policy.configuration);
      return projected ? { ...base, t: "configuration", ...projected } : null;
    }
    case "permission": {
      if (context.policy.permissions === "none") return null;
      return {
        ...base, t: "permission", permissionId: event.permissionId, event: event.event,
        ...(event.activityId === undefined ? {} : { activityId: event.activityId }),
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        ...(context.policy.permissions === "full" && event.fullDetails !== undefined
          ? { details: structuredClone(event.fullDetails) }
          : {}),
      };
    }
    case "transition":
      return transcriptTransition(base, event, context.policy.transitions);
    case "metering_reference":
      if (!context.policy.usage) return null;
      return {
        ...base, t: "metering_reference", operationId: event.operationId,
        meteringRecordId: event.meteringRecordId, status: event.status,
        ...(event.summary === undefined ? {} : { summary: structuredClone(event.summary) }),
      };
    case "lifecycle":
      if (!context.policy.lifecycle) return null;
      return { ...base, t: "lifecycle", event: event.event, ...(event.detail === undefined ? {} : { detail: structuredClone(event.detail) }) };
    case "protocol_metadata":
      if (context.policy.protocol === "none") return null;
      return {
        ...base, t: "protocol", event: event.event, protocol: structuredClone(event.protocol),
        ...(event.agent === undefined ? {} : { agent: structuredClone(event.agent) }),
        capabilities: sortBooleanRecord(event.capabilities),
      };
    case "raw_protocol":
      if (context.policy.protocol !== "raw") return null;
      return { ...base, t: "raw", protocol: event.protocol, direction: event.direction, event: event.event, data: structuredClone(event.data) };
  }
}

export function projectAuditEvent(
  event: NormalizedPersistenceEvent,
  context: AuditProjectionContext,
): KnownAuditLogRecord | null {
  const base = auditEnvelope(context);
  switch (event.kind) {
    case "operation":
      return {
        ...base, t: "operation", event: event.event, operationId: event.operationId,
        operationKind: event.operationKind,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        ...(event.abortReason === undefined ? {} : { abortReason: event.abortReason }),
      };
    case "checkpoint":
    case "message":
    case "protocol_metadata":
    case "raw_protocol":
      return null;
    case "reasoning":
      if (context.policy.reasoning === "none") return null;
      return { ...base, t: "reasoning", reasoningId: event.reasoningId, reasoningRevision: event.reasoningRevision, operationId: event.operationId, text: event.text, status: event.status };
    case "activity": {
      const data = activityData(event.activity, context.policy.tools);
      if (!data) return null;
      return activityRecord(base, event.activity, data);
    }
    case "configuration": {
      const projected = configurationData(event, context.policy.configuration);
      return projected ? { ...base, t: "configuration", ...projected } : null;
    }
    case "permission":
      if (context.policy.permissions === "none") return null;
      return {
        ...base, t: "permission", permissionId: event.permissionId, event: event.event,
        ...(event.activityId === undefined ? {} : { activityId: event.activityId }),
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        ...(context.policy.permissions === "full" && event.fullDetails !== undefined
          ? { details: structuredClone(event.fullDetails) }
          : {}),
      };
    case "transition":
      if (context.policy.transitions === "none") return null;
      return {
        ...base, t: "transition", transitionId: event.transitionId, kind: event.transitionKind,
        event: event.event, from: auditDescriptor(event.from),
        ...(event.to === undefined ? {} : { to: auditDescriptor(event.to)! }),
        ...(event.failedAfter === undefined ? {} : { failedAfter: event.failedAfter }),
        ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      };
    case "metering_reference":
      if (!context.policy.usage) return null;
      return {
        ...base, t: "metering_reference", operationId: event.operationId,
        meteringRecordId: event.meteringRecordId, status: event.status,
        ...(event.summary === undefined ? {} : { summary: structuredClone(event.summary) }),
      };
    case "lifecycle":
      if (!context.policy.lifecycle) return null;
      return { ...base, t: "lifecycle", event: event.event, ...(event.detail === undefined ? {} : { detail: structuredClone(event.detail) }) };
  }
}

function transcriptEnvelope(context: TranscriptProjectionContext): TranscriptEnvelope {
  return { v: 2, t: "raw", transcriptId: context.transcriptId, generation: context.generation, agentSessionId: context.agentSessionId, seq: context.seq, ts: context.ts };
}

function auditEnvelope(context: AuditProjectionContext): AuditLogEnvelope {
  return { v: 1, t: "lifecycle", auditLogId: context.auditLogId, generation: context.generation, agentSessionId: context.agentSessionId, seq: context.seq, ts: context.ts };
}

function activityData(
  activity: NormalizedActivityProjection,
  level: TranscriptCapturePolicy["tools"],
): JsonObject | null {
  if (level === "none") return null;
  const data: JsonObject = {};
  if (activity.metadata?.providerActivityId !== undefined) data.providerActivityId = activity.metadata.providerActivityId;
  if (activity.metadata?.startedAt !== undefined) data.startedAt = activity.metadata.startedAt;
  if (activity.metadata?.endedAt !== undefined) data.endedAt = activity.metadata.endedAt;
  if (activity.metadata?.durationMs !== undefined) data.durationMs = activity.metadata.durationMs;
  if (level === "input" || level === "content") {
    if (activity.input !== undefined) data.input = structuredClone(activity.input);
  }
  if (level === "content" && activity.content !== undefined) data.content = structuredClone(activity.content);
  return data;
}

function activityRecord(base: TranscriptEnvelope, activity: NormalizedActivityProjection, data: JsonObject): TranscriptActivityRecord;
function activityRecord(base: AuditLogEnvelope, activity: NormalizedActivityProjection, data: JsonObject): AuditLogActivityRecord;
function activityRecord(
  base: TranscriptEnvelope | AuditLogEnvelope,
  activity: NormalizedActivityProjection,
  data: JsonObject,
): TranscriptActivityRecord | AuditLogActivityRecord {
  return {
    ...base, t: "activity", activityId: activity.activityId,
    activityRevision: activity.activityRevision, operationId: activity.operationId,
    reason: activity.reason, kind: activity.kind,
    ...(activity.status === undefined ? {} : { status: activity.status }), data,
  } as TranscriptActivityRecord | AuditLogActivityRecord;
}

function configurationData(
  event: Extract<NormalizedPersistenceEvent, { kind: "configuration" }>,
  level: TranscriptCapturePolicy["configuration"],
): Omit<Extract<KnownTranscriptRecord, { t: "configuration" }>, keyof TranscriptEnvelope | "t"> | null {
  if (level === "none") return null;
  return {
    event: event.event,
    ...(event.configId === undefined ? {} : { configId: event.configId }),
    ...(event.value === undefined ? {} : { value: structuredClone(event.value) }),
    ...(level === "definitions" && event.definitions !== undefined ? { definitions: structuredClone(event.definitions) } : {}),
    ...(event.schemaDigest === undefined ? {} : { schemaDigest: event.schemaDigest }),
  };
}

function transcriptTransition(
  base: TranscriptEnvelope,
  event: Extract<NormalizedPersistenceEvent, { kind: "transition" }>,
  level: TranscriptCapturePolicy["transitions"],
): TranscriptTransitionRecord {
  // Transition routing and activation/history are continuation structure and are retained
  // even when presentation capture is disabled. Only prose/content follows the preset.
  return {
    ...base, t: "transition", transitionId: event.transitionId, kind: event.transitionKind,
    event: event.event, from: structuredClone(event.from),
    ...(event.to === undefined ? {} : { to: structuredClone(event.to) }),
    ...(event.historyEntry === undefined ? {} : { historyEntry: structuredClone(event.historyEntry) }),
    ...(event.activationState === undefined ? {} : { activationState: structuredClone(event.activationState) }),
    ...(event.failedAfter === undefined ? {} : { failedAfter: event.failedAfter }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(level === "content" && event.summary !== undefined ? { summary: event.summary } : {}),
    ...(level === "content" && event.reasonText !== undefined ? { reasonText: event.reasonText } : {}),
  };
}

function auditDescriptor(value: InternalSessionDescriptor | null): AuditInternalSessionDescriptor | null {
  if (value === null) return null;
  return {
    internalSessionId: value.internalSessionId,
    adapterId: value.adapterId,
    mode: value.mode,
    model: value.model,
    protocol: structuredClone(value.protocol),
  };
}

function sortBooleanRecord(value: Readonly<Record<string, boolean>>): Readonly<Record<string, boolean>> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
