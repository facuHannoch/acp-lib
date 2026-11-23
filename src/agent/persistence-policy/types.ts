import type { AgentConversationId } from "../../agent-ids.ts";
import type { AgentAuditCaptureConfig, NormalizedAgentLevelObservation } from "../../audit/index.ts";
import type {
  ConversationRecordCaptureConfig,
  MeteringRecordRetention,
  ParticipantRef,
} from "../../persistence/backend.ts";

/** Audit kinds observed at agent scope; they cannot be tuned per conversation. */
export type AgentScopeAuditObservationKind = NormalizedAgentLevelObservation["kind"];

export type AgentConversationAuditCaptureConfig = Omit<AgentAuditCaptureConfig, AgentScopeAuditObservationKind>;

/**
 * What one conversation persists differently from the Agent defaults. Keys it sets replace the Agent's
 * values; keys it omits follow the Agent. `undefined` and `{}` both mean "use the Agent defaults".
 *
 */
export interface AgentConversationPersistenceOverride {
  /** Canonical record capture. Keys set here replace the Agent's; omitted keys inherit. */
  readonly capture?: ConversationRecordCaptureConfig;
  /**
   * `false` keeps this conversation out of the audit stream entirely: no entry about it, none caused by its
   * records. An object changes what its audit entries capture (agent-scope kinds cannot be tuned per
   * conversation). Requires the Agent to have an audit log.
   */
  readonly auditLog?: false | { readonly capture?: AgentConversationAuditCaptureConfig };
  /** Detailed metering-record retention for this conversation (`"all"`, `"none"` or `{ retain: n }`). */
  readonly meteringRecords?: MeteringRecordRetention;
}

/** What the library knows about a conversation when it asks for its policy. */
export interface ConversationPersistenceContext {
  readonly agentConversationId: AgentConversationId;
  readonly participants: readonly ParticipantRef[];
  readonly title?: string;
  readonly metadata?: string;
  /** True when the conversation was created by adopting an existing provider session. */
  readonly adopted: boolean;
  readonly role?: "worker";
}

/**
 * Chooses what a conversation persists. It runs when a conversation starts and whenever a write about a
 * conversation that is not live needs its policy, so it must be synchronous, free of side effects and
 * stable for a given conversation. The library infers nothing: what a conversation *is* stays the
 * consumer's business.
 */
export type ConversationPersistenceResolver = (
  conversation: ConversationPersistenceContext,
) => AgentConversationPersistenceOverride | undefined;
