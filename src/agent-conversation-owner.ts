import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type { Adapter } from "./adapters.ts";
import type { AgentMode } from "./controller.ts";
import type { NewConversationRecord, ParticipantRef, PersistenceJsonValue } from "./persistence/backend.ts";
import type { AgentSessionPromptResult } from "./agent-conversation-contracts.ts";
import type { ResponseMessage } from "./types.ts";
import type { OperationMeteringRecord } from "./metering/record.ts";
import type { AgentSessionMeteringState } from "./metering/state.ts";
import type { IdentityDeliveryReceipt } from "./identity.ts";
import type {
  ProviderAttachmentCommitAcknowledgement,
  ProviderAttachmentState,
} from "./persistence/provider-attachment.ts";

export interface OwnedPromptInput {
  readonly operationId: string;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly targetProviderContextId?: string;
  readonly participantId?: string;
  readonly consumerMetadata?: PersistenceJsonValue;
  readonly text: string;
}

export interface OwnedPromptPreparation {
  readonly providerText?: string;
  readonly participant?: ParticipantRef;
  readonly identityDeliveryReceipt?: IdentityDeliveryReceipt;
}

export interface OwnedPromptCompleted extends OwnedPromptInput {
  readonly result: AgentSessionPromptResult;
  readonly identityDeliveryReceipt?: IdentityDeliveryReceipt;
  readonly providerAttachment: ProviderAttachmentState;
}

export interface OwnedPromptCommitResult {
  readonly providerAttachment?: ProviderAttachmentCommitAcknowledgement;
}

/** @internal Indicates that the local prompt commit succeeded but a follow-up hook failed. */
export class OwnedPromptPostCommitError extends Error {
  constructor(
    readonly commit: OwnedPromptCommitResult,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OwnedPromptPostCommitError";
  }
}

export interface OwnedPromptFailed extends OwnedPromptInput {
  readonly messages: readonly ResponseMessage[];
  readonly error: unknown;
}

/** @internal Agent-owned persistence and identity boundary for a conversation turn. */
export interface AgentConversationOwnerLifecycle {
  beforePrompt(input: OwnedPromptInput): Promise<OwnedPromptPreparation>;
  afterPrompt(input: OwnedPromptCompleted): Promise<OwnedPromptCommitResult | void>;
  promptFailed(input: OwnedPromptFailed): Promise<void>;
  /** Durably commit one normalized operation record and its bounded next state. */
  meteringRecorded?(record: OperationMeteringRecord): Promise<void>;
  /** Persist a bounded state change that did not itself mint an operation record. */
  meteringStateChanged?(state: AgentSessionMeteringState): Promise<void>;
  /** Resolve an agent-scoped route for a cross-adapter transition. */
  resolveAdapter?(adapterId: string): Adapter;
  /** Commit the newly active provider route before it becomes observable in memory. */
  transitionActivated?(input: {
    readonly transitionId: string;
    readonly agentConversationId: AgentConversationId;
    readonly internalSessionId: string;
    readonly adapterId: string;
    readonly mode: AgentMode;
    readonly model?: string;
    readonly activatedAt: string;
  }): Promise<void>;
  /** Append a typed non-message runtime observation under the owner's capture policy. */
  record?(record: NewConversationRecord): Promise<void>;
}
