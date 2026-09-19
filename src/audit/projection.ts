import { shouldCaptureProtocolMethod, type PersistenceJsonValue } from "../persistence/backend.ts";
import type { AgentAuditCaptureLevel, NormalizedAgentObservation, ProjectedAgentAuditObservation } from "./contracts.ts";
import type { ResolvedAgentAuditCapturePolicy } from "./config.ts";

export function projectAgentAuditObservation(
  observation: NormalizedAgentObservation,
  policy: ResolvedAgentAuditCapturePolicy,
): ProjectedAgentAuditObservation | null {
  if (observation.scope === "agent") {
    const level = policy[observation.kind];
    if (level === "none") return null;
    return Object.freeze({
      sourceObservationId: observation.sourceObservationId,
      agentSessionId: observation.agentSessionId,
      ...(observation.operationId ? { operationId: observation.operationId } : {}),
      occurredAt: observation.occurredAt,
      kind: observation.kind,
      captureLevel: level,
      payload: level === "metadata"
        ? { state: observation.state }
        : { state: observation.state, ...(observation.payload !== undefined ? { payload: observation.payload } : {}) },
    });
  }

  const record = observation.record;
  const configured = record.kind === "protocol" ? policy.protocol.level : policy[record.kind];
  if (configured === "none") return null;
  if (record.kind === "protocol" && !shouldCaptureProtocolMethod(policy.protocol, record.method)) return null;
  const captureLevel = configured as AgentAuditCaptureLevel;
  return Object.freeze({
    sourceObservationId: observation.sourceObservationId,
    agentSessionId: record.agentSessionId,
    agentConversationId: record.agentConversationId,
    sourceRecordId: record.recordId,
    ...(observation.operationId
      ? { operationId: observation.operationId }
      : "operationId" in record && record.operationId
        ? { operationId: record.operationId }
        : {}),
    occurredAt: record.timestamp,
    kind: record.kind,
    captureLevel,
    payload: projectRecordPayload(observation, captureLevel),
  });
}

function projectRecordPayload(
  observation: Extract<NormalizedAgentObservation, { scope: "conversation" }>,
  level: AgentAuditCaptureLevel,
): PersistenceJsonValue {
  const record = observation.record;
  const base: Record<string, PersistenceJsonValue> = {
    recordId: record.recordId,
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
  switch (record.kind) {
    case "message":
      return { ...base, role: record.role, ...(record.participantId ? { participantId: record.participantId } : {}),
        ...(record.status ? { status: record.status } : {}), ...(level !== "metadata" ? { content: json(record.content) } : {}) };
    case "tool_call":
      return { ...base, toolCallId: record.toolCallId, state: record.state, ...(record.name ? { name: record.name } : {}),
        ...(["input", "content", "raw"].includes(level) && record.input !== undefined ? { input: record.input } : {}),
        ...(["content", "raw"].includes(level) && record.output !== undefined ? { output: json(record.output) } : {}),
        ...(["content", "raw"].includes(level) && record.error ? { error: record.error } : {}) };
    case "permission":
      return { ...base, permissionId: record.permissionId, state: record.state,
        ...(["decision", "content", "raw"].includes(level) && record.request !== undefined ? { request: record.request } : {}),
        ...(record.outcome ? { outcome: record.outcome } : {}) };
    case "configuration":
      return { ...base, operation: record.operation, status: record.status, ...(record.configId ? { configId: record.configId } : {}),
        ...(["selections", "definitions", "content", "raw"].includes(level) && record.value !== undefined ? { value: record.value } : {}),
        ...(["content", "raw"].includes(level) && record.error ? { error: record.error } : {}) };
    case "protocol":
      return { ...base, direction: record.direction, ...(record.method ? { method: record.method } : {}),
        ...(level === "raw" && record.message !== undefined ? { message: record.message } : {}) };
    case "native_action":
    case "agent_action":
      return { ...base, action: record.action, state: record.state,
        ...(level !== "metadata" && record.input !== undefined ? { input: record.input } : {}),
        ...(level !== "metadata" && record.output !== undefined ? { output: record.output } : {}),
        ...(level !== "metadata" && record.error ? { error: record.error } : {}) };
    case "thinking":
      return { ...base, thinkingId: record.thinkingId, state: record.state,
        ...(level !== "metadata" ? { content: json(record.content) } : {}) };
    case "activity":
      return { ...base, activityId: record.activityId, activityType: record.activityType, state: record.state,
        ...(level !== "metadata" && record.content !== undefined ? { content: json(record.content) } : {}),
        ...(level === "raw" && record.data !== undefined ? { data: record.data } : {}) };
    case "metering": {
      const metering = observation.meteringRecord;
      if (level === "raw" && metering) return json(metering);
      if (level === "summary" && metering) return json({
        operationId: metering.operationId,
        operationKind: metering.operationKind,
        outcome: metering.outcome,
        provider: metering.provider,
        usage: metering.usage,
        pricingStatus: metering.pricingStatus,
        providerCostAfter: metering.providerCostAfter,
      });
      return { ...base, operationId: record.operationId, meteringRecordId: record.meteringRecordId, status: record.status };
    }
  }
}

function json(value: unknown): PersistenceJsonValue {
  return JSON.parse(JSON.stringify(value)) as PersistenceJsonValue;
}
