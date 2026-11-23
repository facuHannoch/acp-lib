import type { AgentConversationId } from "../agent-ids.ts";

export interface WorkerRow {
  readonly handle: string;
  readonly conversationId: AgentConversationId;
  readonly openedBy: AgentConversationId | "consumer";
  readonly about?: string;
  readonly lastConversation?: AgentConversationId;
  readonly createdAt: string;
  readonly droppedAt?: string;
}

export interface WorkerPersistence {
  create(worker: WorkerRow): Promise<void>;
  get(handle: string): Promise<WorkerRow | undefined>;
  list(): Promise<readonly WorkerRow[]>;
  update(handle: string, change: Pick<WorkerRow, "about" | "lastConversation">): Promise<boolean>;
  drop(handle: string, droppedAt: string): Promise<boolean>;
}
