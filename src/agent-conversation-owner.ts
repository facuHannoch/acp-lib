import type { MessagePart, ResolvedPart } from "./media/parts.ts";
import type { Attachment } from "./types.ts";
import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type { Adapter } from "./adapters.ts";
import type { AgentMode } from "./controller.ts";
import type { NewConversationRecord, ParticipantRef, PersistenceJsonValue } from "./persistence/backend.ts";
import type { AgentSessionPromptResult } from "./agent-conversation-contracts.ts";
import type { CombinedMessage } from "./steering/contracts.ts";
import type { ResponseMessage } from "./types.ts";
import type { OperationMeteringRecord } from "./metering/record.ts";
import type { AgentSessionMeteringState } from "./metering/state.ts";
import type { IdentityDeliveryReceipt } from "./identity.ts";
import type { OperationStalledError } from "./operations/errors.ts";
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
  /** Present when several messages were combined into this one prompt: each is recorded as sent. */
  readonly parts?: readonly CombinedMessage[];
  readonly text: string;
  readonly messageParts?: readonly MessagePart[];
  readonly attachments?: readonly Attachment[];
  readonly mediaContext?: { cwd: string; capabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }; degraded?: boolean };
}

/** How a turn's assistant messages ended, for its commit. */
interface OwnedPromptMessageEnds {
  /**
   * When each message that ended before the turn did (the next message or a tool call began)
   * received its last text, in order. Those messages are completed at these times; the rest take
   * the turn's outcome.
   */
  readonly messageEnds?: readonly string[];
}

export interface OwnedPromptPreparation {
  readonly providerParts?: readonly ResolvedPart[];
  readonly providerText?: string;
  readonly participant?: ParticipantRef;
  /** Every participant of a combined prompt, in order. `participant` is the first. */
  readonly participants?: readonly ParticipantRef[];
  readonly identityDeliveryReceipt?: IdentityDeliveryReceipt;
}

export interface OwnedPromptCompleted extends OwnedPromptInput, OwnedPromptMessageEnds {
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

export interface OwnedPromptFailed extends OwnedPromptInput, OwnedPromptMessageEnds {
  readonly messages: readonly ResponseMessage[];
  readonly error: unknown;
}

/** @internal Agent-owned persistence and identity boundary for a conversation turn. */
export interface AgentConversationOwnerLifecycle {
  operationFailed?(input: { readonly operationId: string; readonly error: OperationStalledError }): Promise<void>;
  recoverInPlace?(error: unknown): Promise<void>;
  beforePrompt(input: OwnedPromptInput): Promise<OwnedPromptPreparation>;
  /** The participant that history imported from an adopted provider session is attributed to. */
  importParticipant?(): Promise<ParticipantRef>;
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
  record?(record: NewConversationRecord, parts?: readonly ResolvedPart[]): Promise<void>;
}
