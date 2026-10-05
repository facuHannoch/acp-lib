import {
  type AgentConversationId,
} from "../agent-ids.ts";
import {
  type IdentityConsistency,
} from "../identity.ts";
import {
  type ConversationRecord,
  type ConversationRecordCapturePolicy,
  type MeteringRecordRetention,
} from "../persistence/backend.ts";
import {
  type ResolvedAgentAuditLogConfig,
} from "../audit/index.ts";
import {
  type ResolvedConversationCheckpointingConfig,
} from "../checkpointing/index.ts";

import type {
  AgentConversationRuntimeDefaults,
} from "./config.ts";

export interface ManagerSettings {
  readonly defaultAdapterId?: string;
  readonly identityConsistency: IdentityConsistency;
  readonly identityTimeoutMs?: number;
  readonly capture: ConversationRecordCapturePolicy;
  readonly defaults: AgentConversationRuntimeDefaults;
  readonly meteringRecords: MeteringRecordRetention;
  readonly checkpointing: ResolvedConversationCheckpointingConfig | null;
  readonly auditLog: ResolvedAgentAuditLogConfig | null;
  readonly auditIdentityUpdate: (
    agentConversationId: AgentConversationId,
    records: readonly ConversationRecord[],
  ) => Promise<void>;
}
