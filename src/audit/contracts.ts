import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type { OperationMeteringRecord } from "../metering/record.ts";
import type {
  NewConversationRecord,
  PersistenceJsonValue,
} from "../persistence/backend.ts";

export type AgentAuditObservationKind =
  | NewConversationRecord["kind"]
  | "agent_lifecycle"
  | "identity"
  | "internal_inference";

export interface NormalizedConversationObservation {
  readonly scope: "conversation";
  readonly sourceObservationId: string;
  readonly operationId?: string;
  readonly record: NewConversationRecord;
  /** Present only for metering observations whose timeline record points at this full record. */
  readonly meteringRecord?: OperationMeteringRecord;
}

export interface NormalizedAgentLevelObservation {
  readonly scope: "agent";
  readonly sourceObservationId: string;
  readonly agentSessionId: AgentSessionId;
  readonly kind: "agent_lifecycle" | "identity" | "internal_inference";
  readonly occurredAt: string;
  readonly state: string;
  readonly operationId?: string;
  readonly payload?: PersistenceJsonValue;
}

/** Internal immutable input shared by canonical and audit projection. */
export type NormalizedAgentObservation =
  | NormalizedConversationObservation
  | NormalizedAgentLevelObservation;

export type AgentAuditCaptureLevel =
  | "metadata"
  | "input"
  | "decision"
  | "selections"
  | "definitions"
  | "content"
  | "summary"
  | "raw";

export interface ProjectedAgentAuditObservation {
  readonly sourceObservationId: string;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly sourceRecordId?: string;
  readonly operationId?: string;
  readonly occurredAt: string;
  readonly kind: AgentAuditObservationKind;
  readonly captureLevel: AgentAuditCaptureLevel;
  readonly payload: PersistenceJsonValue;
}
