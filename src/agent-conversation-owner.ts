import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type { ParticipantRef } from "./persistence/backend.ts";
import type { AgentSessionPromptResult } from "./agent-conversation-contracts.ts";
import type { ResponseMessage } from "./types.ts";

export interface OwnedPromptInput {
  readonly operationId: string;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly participantId?: string;
  readonly text: string;
}

export interface OwnedPromptPreparation {
  readonly providerText?: string;
  readonly participant?: ParticipantRef;
}

export interface OwnedPromptCompleted extends OwnedPromptInput {
  readonly result: AgentSessionPromptResult;
}

export interface OwnedPromptFailed extends OwnedPromptInput {
  readonly messages: readonly ResponseMessage[];
  readonly error: unknown;
}

/** @internal Agent-owned persistence and identity boundary for a conversation turn. */
export interface AgentConversationOwnerLifecycle {
  beforePrompt(input: OwnedPromptInput): Promise<OwnedPromptPreparation>;
  afterPrompt(input: OwnedPromptCompleted): Promise<void>;
  promptFailed(input: OwnedPromptFailed): Promise<void>;
}
