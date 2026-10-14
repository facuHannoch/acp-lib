import { randomUUID } from "node:crypto";
import {
  type AgentConversationId,
} from "../agent-ids.ts";
import {
  AgentAdapterRegistry,
} from "../agent-adapter-registry.ts";
import type { MeteredOperationKind } from "../metering/record.ts";
import {
  NoopAgentIdentityRuntime,
  composeIdentityPrompt,
} from "../identity.ts";
import {
  IMPLICIT_USER_PARTICIPANT_ID,
  PersistenceCapabilityError,
  normalizeParticipantRef,
  shouldCaptureProtocolMethod,
  type ConversationErrorDetails,
  type ConversationRecord,
  type NewConversationRecord,
  type ParticipantRef,
  type PersistenceBackend,
  type PersistenceScope,
  type RecordCaptureLevel,
} from "../persistence/backend.ts";
import {
  projectAgentAuditObservation,
  type NormalizedAgentObservation,
  type ResolvedAgentAuditLogConfig,
} from "../audit/index.ts";
import { conversationErrorDetailsFromError } from "../persistence/error-records.ts";


import type { Agent } from "../agent.ts";
import type { ManagerSettings } from "./manager-settings.ts";

export async function updateConversationIdentity(
  agent: Agent,
  settings: ManagerSettings,
  conversationId: AgentConversationId,
  records: readonly ConversationRecord[],
): Promise<void> {
  await agent.identity.update({
    agentSessionId: agent.id,
    agentConversationId: conversationId,
    records,
  });
  // A conversation kept out of the audit stream causes no `identity` entry either.
  if (settings.auditLog) await settings.auditIdentityUpdate(conversationId, records);
}

/**
 * Append one canonical record about a conversation under that conversation's capture and audit policy, inside
 * the given transaction. Returns the stored record, or `undefined` when capture dropped it.
 */
export async function appendCanonicalRecord(
  settings: ManagerSettings,
  persistence: PersistenceScope,
  record: NewConversationRecord,
): Promise<ConversationRecord | undefined> {
  const persisted: ConversationRecord[] = [];
  await persistObservationsInTransaction(settings, persistence, [record], true, persisted);
  return persisted[0];
}

/** Persist canonical records and their audit intents in one transaction, then publish them. */
export async function persistConversationObservations(
  agent: Agent,
  settings: ManagerSettings,
  records: readonly NewConversationRecord[],
  audit = true,
): Promise<readonly ConversationRecord[]> {
  if (records.length === 0) return Object.freeze([]);
  if ((!audit || !settings.auditLog) && records.every((record) => {
    if (record.kind !== "protocol") return settings.capture[record.kind] === "none";
    return settings.capture.protocol.level === "none"
      || !shouldCaptureProtocolMethod(settings.capture.protocol, record.method);
  })) return Object.freeze([]);
  const persisted: ConversationRecord[] = [];
  await agent.persistence.transaction(async (persistence) => {
    await persistObservationsInTransaction(settings, persistence, records, audit, persisted);
  });
  agent.publishCommittedRecords(persisted);
  if (audit && settings.auditLog) agent.audit?.notifyPending();
  return Object.freeze(persisted);
}

export async function persistObservationsInTransaction(
  settings: ManagerSettings,
  persistence: PersistenceScope,
  records: readonly NewConversationRecord[],
  audit: boolean,
  persisted: ConversationRecord[],
): Promise<void> {
  for (const record of records) {
    const level = record.kind === "protocol"
      ? settings.capture.protocol.level
      : settings.capture[record.kind];
    const canonicalAccepted = level !== "none" && (
      record.kind !== "protocol"
      || shouldCaptureProtocolMethod(settings.capture.protocol, record.method)
    );
    if (canonicalAccepted) {
      persisted.push(await persistence.records.append(captureRuntimeRecord(record, level)));
    }
    if (audit && settings.auditLog) {
      await enqueueAuditObservation(persistence, {
        scope: "conversation",
        sourceObservationId: record.recordId,
        operationId: operationIdFromMetadata(record.metadata),
        record,
      }, settings.auditLog);
    }
  }
}

export function normalizeParticipants(participants?: readonly ParticipantRef[]): readonly ParticipantRef[] {
  const values = participants?.length
    ? participants.map(normalizeParticipantRef)
    : [{ id: IMPLICIT_USER_PARTICIPANT_ID, kind: "user" as const }];
  const seen = new Set<string>();
  for (const participant of values) {
    if (seen.has(participant.id)) throw new Error(`duplicate participant id: ${participant.id}`);
    seen.add(participant.id);
  }
  return Object.freeze(values);
}

export function internalInferenceMeteringKind(purpose: string): MeteredOperationKind {
  if (
    purpose === "conversation_checkpoint"
    || purpose === "conversation_recovery"
    || purpose === "identity_update"
  ) return purpose;
  return "internal_command";
}

export function captureRuntimeRecord(
  record: NewConversationRecord,
  level: RecordCaptureLevel,
): NewConversationRecord {
  if (record.kind === "error") {
    // `metadata` omits the display message and details; `content` keeps the message but
    // still omits details; `raw` retains the allow-listed details.
    if (level === "raw") return record;
    const { details: _details, message, ...rest } = record;
    return level === "content"
      ? { ...rest, ...(message === undefined ? {} : { message }) }
      : rest;
  }
  if (level !== "metadata") return record;
  switch (record.kind) {
    case "message":
      return { ...record, content: "" };
    case "tool_call":
      return {
        recordId: record.recordId,
        agentSessionId: record.agentSessionId,
        agentConversationId: record.agentConversationId,
        kind: record.kind,
        timestamp: record.timestamp,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        toolCallId: record.toolCallId,
        state: record.state,
        ...(record.name ? { name: record.name } : {}),
      };
    case "permission":
      return {
        recordId: record.recordId,
        agentSessionId: record.agentSessionId,
        agentConversationId: record.agentConversationId,
        kind: record.kind,
        timestamp: record.timestamp,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        permissionId: record.permissionId,
        state: record.state,
        ...(record.outcome ? { outcome: record.outcome } : {}),
      };
    case "configuration":
      return { ...record, value: undefined };
    case "protocol":
      return { ...record, message: undefined };
    case "native_action":
    case "agent_action":
      return { ...record, input: undefined, output: undefined };
    case "thinking":
      return { ...record, content: "" };
    case "activity":
      return { ...record, content: undefined, data: undefined };
    case "metering":
      return record;
  }
}

export async function enqueueAuditObservation(
  persistence: PersistenceBackend | PersistenceScope,
  observation: NormalizedAgentObservation,
  config: ResolvedAgentAuditLogConfig,
): Promise<void> {
  const projected = projectAgentAuditObservation(observation, config.capture);
  if (!projected) return;
  if (!persistence.auditOutbox) throw new PersistenceCapabilityError("auditOutbox");
  await persistence.auditOutbox.enqueue({
    outboxId: `aud-${randomUUID()}`,
    sourceObservationId: projected.sourceObservationId,
    ...(projected.sourceRecordId ? { sourceRecordId: projected.sourceRecordId } : {}),
    ...(projected.operationId ? { operationId: projected.operationId } : {}),
    ...(projected.agentConversationId ? { agentConversationId: projected.agentConversationId } : {}),
    occurredAt: projected.occurredAt,
    kind: projected.kind,
    captureLevel: projected.captureLevel,
    captureFingerprint: config.captureFingerprint,
    payload: projected.payload,
    createdAt: new Date().toISOString(),
  });
}

/** Allow-listed machine-readable detail from a raw ACP error, when it exposes any. */
export const providerSessionErrorDetails = conversationErrorDetailsFromError;

export function operationIdFromMetadata(metadata: string | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const value = JSON.parse(metadata) as { operationId?: unknown };
    return typeof value.operationId === "string" && value.operationId ? value.operationId : undefined;
  } catch {
    return undefined;
  }
}

export { AgentAdapterRegistry, NoopAgentIdentityRuntime, composeIdentityPrompt };
