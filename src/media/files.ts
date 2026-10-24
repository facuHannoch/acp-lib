import type { AgentConversationId } from "../agent-ids.ts";
import type { PersistedMediaBlock } from "../persistence/backend.ts";
import type { MediaKind } from "./parts.ts";

export interface SharedFileQuery {
  readonly agentConversationId?: AgentConversationId;
  readonly text?: string;
  readonly name?: string;
  readonly kind?: MediaKind;
  readonly mimeType?: string;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface SharedFile extends PersistedMediaBlock {
  readonly agentConversationId: AgentConversationId;
  readonly recordId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly role: "assistant" | "user";
  readonly partIndex: number;
}
export interface SharedFilePage { readonly files: readonly SharedFile[]; readonly nextCursor?: string; }
export interface SharedFilesPersistence {
  list(query?: SharedFileQuery): Promise<SharedFilePage>;
  search(query: SharedFileQuery & { readonly text: string }): Promise<SharedFilePage>;
}
