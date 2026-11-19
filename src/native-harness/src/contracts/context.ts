import type { Message, ToolCall, ExecuteTool } from "./loop.ts";
import type { LoopEvent } from "./events.ts";

/** Attributed agent experience; system instructions are configuration, not events. */
export interface ContextEntry {
  seq: number;
  at: string;
  channelId: string;
  turnId: number;
  from: string;
  kind?: "participant_message" | "channel_notice";
  sourceChannelId?: string;
  message: Message;
}

/** Read-only projection of the storage timeline. Values never alias stored
 * records. Listeners run after a commit that changed the timeline. */
export interface SharedContextStore {
  snapshot(): ContextEntry[];
  subscribe(listener: () => void): () => void;
}

/** Turn-scoped operations. Build must read a fresh snapshot on every call. */
export interface TurnContext {
  append(message: Message): void;
  build(): Message[];
  /** The sole dispatch boundary. It records dispatch before invoking the tool,
   * emits started only for a dispatch, and returns a paired skipped result for
   * denial or closed approval. */
  dispatchTool(call: ToolCall, execute: ExecuteTool): Promise<{ content: string; dispatched: boolean }>;
  /** Take pending inbox items (messages and notices) into this turn. */
  drainNotices?(): void;
  finish?(): boolean;
  emit?(event: LoopEvent): void;
  /** Decision 0013. Throwing from append means the turn was fenced (stopped or
   * ended); the loop must not continue. The members below mirror TurnPort. */
  confirm?(milestone: "delivered" | "seen"): void;
  checkpoint?(): boolean;
  signal?: AbortSignal;
}
