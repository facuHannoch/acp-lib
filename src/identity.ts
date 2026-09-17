import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type { ConversationRecord, ParticipantRef, PersistenceJsonValue } from "./persistence/backend.ts";

export type IdentityConsistency = "eventual" | "through-current";

export interface IdentityLoadInput {
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly participant?: ParticipantRef;
  readonly prompt: string;
  readonly consistency: IdentityConsistency;
  readonly timeoutMs?: number;
}

export interface LoadedIdentityContext {
  /** Optional private context prepended only to the provider prompt, never to chat history. */
  readonly promptPreamble?: string;
  readonly snapshotVersion?: number;
  readonly observedThroughSequence?: number;
  readonly processedThroughSequence?: number;
  readonly metadata?: PersistenceJsonValue;
}

export interface IdentityUpdateInput {
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly records: readonly ConversationRecord[];
}

export interface IdentitySynchronizationInput {
  readonly agentSessionId: AgentSessionId;
  readonly throughSequence: number;
  readonly timeoutMs?: number;
}

export interface IdentityWatermark {
  readonly observedThroughSequence: number;
  readonly processedThroughSequence: number;
}

export interface AgentIdentityRuntime {
  load(input: IdentityLoadInput): Promise<LoadedIdentityContext>;
  update(input: IdentityUpdateInput): Promise<void>;
  synchronize?(input: IdentitySynchronizationInput): Promise<IdentityWatermark>;
}

/** Default identity policy: deliberately remembers and injects nothing, but is still called. */
export class NoopAgentIdentityRuntime implements AgentIdentityRuntime {
  async load(_input: IdentityLoadInput): Promise<LoadedIdentityContext> {
    return EMPTY_IDENTITY_CONTEXT;
  }

  async update(_input: IdentityUpdateInput): Promise<void> {}
}

const EMPTY_IDENTITY_CONTEXT: LoadedIdentityContext = Object.freeze({});

export function composeIdentityPrompt(prompt: string, context: LoadedIdentityContext): string {
  const preamble = context.promptPreamble?.trim();
  if (!preamble) return prompt;
  return `${preamble}\n\n<current-message>\n${prompt}\n</current-message>`;
}
