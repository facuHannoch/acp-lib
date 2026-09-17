import type { ConversationRecoveryCheckpointId } from "./contracts.ts";

export function createConversationRecoveryCheckpointId(): ConversationRecoveryCheckpointId {
  return `chk-${crypto.randomUUID()}`;
}
