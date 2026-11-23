import {
  type AgentConversationId,
} from "../agent-ids.ts";
import {
  type IdentityConsistency,
} from "../identity.ts";
import {
  type ConversationRecord,
  type ConversationRecordCaptureConfig,
  type ConversationRecordCapturePolicy,
  type MeteringRecordRetention,
} from "../persistence/backend.ts";
import {
  type AgentAuditCaptureConfig,
  type ResolvedAgentAuditLogConfig,
} from "../audit/index.ts";
import {
  type ResolvedConversationCheckpointingConfig,
} from "../checkpointing/index.ts";

import type {
  AgentConversationRuntimeDefaults,
} from "./config.ts";
import type { ConversationPersistenceResolver } from "./persistence-policy/types.ts";

export interface ManagerSettings {
  readonly role?: "worker";
  readonly defaultAdapterId?: string;
  readonly identityConsistency: IdentityConsistency;
  readonly identityTimeoutMs?: number;
  /** The Agent's resolved capture. A conversation's own settings replace it (see persistence-policy). */
  readonly capture: ConversationRecordCapturePolicy;
  /** The Agent's capture as configured, which per-conversation overrides are layered over. */
  readonly captureConfig?: ConversationRecordCaptureConfig;
  /** The Agent's audit capture as configured, which per-conversation audit overrides are layered over. */
  readonly auditCaptureConfig?: AgentAuditCaptureConfig;
  /** The consumer's per-conversation resolver, if any. */
  readonly conversationPersistence?: ConversationPersistenceResolver;
  readonly defaults: AgentConversationRuntimeDefaults;
  readonly meteringRecords: MeteringRecordRetention;
  readonly checkpointing: ResolvedConversationCheckpointingConfig | null;
  readonly auditLog: ResolvedAgentAuditLogConfig | null;
  readonly auditIdentityUpdate: (
    agentConversationId: AgentConversationId,
    records: readonly ConversationRecord[],
  ) => Promise<void>;
}
