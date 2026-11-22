import type { Message, ToolDefinition } from "./loop.ts";
import type { StorageResult, TimelineEntry } from "./storage.ts";

/** One immutable logical request, identical across the attempts of a call. */
export interface ModelRequest { messages: readonly Message[]; tools: readonly ToolDefinition[];
  /** IDs first included at this inference boundary, in take order. The first
   * boundary includes the initial input group. Later boundaries include inputs
   * taken since the preceding boundary, including across checkpoint resume.
   * Retries carry the same frozen list. Local observations pair it with the
   * attempt ordinal. Every provider client omits it from wire requests. */
  takenItemIds?: readonly string[];
  /** Decision 0021: the first N tools are the stable group (built-ins and
   * fixed registrations); the rest can change between inferences. Absent: all
   * are stable. Adapters may place the groups differently; both use one gate. */
  fixedToolCount?: number }
/** Defaults apply per call and never include tool or approval time. */
export interface ModelExecutionSettings { timeoutMs: number; retryDelayMs: number; maxRetries: number }
/** `final` remains the existing wire spelling for messages mode. */
export type ModelTextSubscription = "final" | "stream";
export type ModelStopReason = "complete" | "tool_calls" | "output_limit";
export type ModelResponse = Extract<Message, { role: "assistant" }> & { stopReason: ModelStopReason };
/** Nonnegative integer counts reported for this attempt; absent means unknown. */
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
/** Ordered, provider-neutral attempt signals. Tool fragments remain private to
 * the adapter; evidence may be emitted without revealing a fragment. */
export type ModelAttemptEvent =
  | { type: "accepted"; providerRequestId?: string }
  | { type: "seen" }
  | { type: "text_delta"; text: string }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response"; response: ModelResponse; providerRequestId?: string }
  | { type: "failure"; kind: "transient" | "invalid_request" | "invalid_config" | "provider"; message: string; providerRequestId?: string };
/** One attempt emits exactly one terminal response or failure unless aborted;
 * EOF without a terminal is incomplete. A consumer ignores events after the
 * first terminal, timeout or abort. The adapter assembles and validates tools. */
export type ModelAttempt = (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelAttemptEvent>;
export type AttemptOutcome = "running" | "succeeded" | "transient_failure" | "invalid_request" | "invalid_config" | "provider_failure" | "incomplete" | "output_limit" | "timeout" | "interrupted";
export type CallOutcome = "running" | "succeeded" | "failed" | "incomplete" | "output_limit" | "timeout" | "interrupted";
/** Records are durable and returned as copies; timestamps are UTC, not ordering keys. */
export interface ModelAttemptSummary {
  attemptId: string; /** Zero-based and contiguous within the call. */ ordinal: number; startedAt: string; endedAt?: string;
  outcome: AttemptOutcome; retryReason?: string; providerRequestId?: string; usage?: ModelUsage;
  /** Zero-based script step reserved atomically at start, when scripted. */
  scriptStep?: number;
}
export interface ModelCallSummary {
  callId: string; turnId: string; channel: string; messageId: string;
  startedAt: string; endedAt?: string; outcome: CallOutcome;
  attempts: ModelAttemptSummary[];
}
/** Durable transitions are atomic and synchronous, and reject ended turns or
 * stale attempts. All provider notifications are published after their commit. */
export interface ModelCallStore {
  /** itemIds is the frozen set of this turn's taken inputs included in the
   * request; storage validates ownership and receipt writes use that set only. */
  startCall(turnId: string, itemIds: readonly string[]): StorageResult<ModelCallSummary>;
  /** Reserves the scripted step in this transaction when scripted is true. */
  startAttempt(callId: string, scripted: boolean): StorageResult<ModelAttemptSummary>;
  confirm(callId: string, attemptId: string, evidence: "delivered" | "seen"): StorageResult<string[]>;
  recordProviderRequestId(callId: string, attemptId: string, providerRequestId: string): StorageResult<void>;
  recordUsage(callId: string, attemptId: string, usage: ModelUsage): StorageResult<void>;
  finishAttempt(callId: string, attemptId: string, outcome: Exclude<AttemptOutcome, "running" | "succeeded">, providerRequestId?: string): StorageResult<void>;
  /** Commits call/attempt success and its complete response in one transaction;
   * messageId equals the ID reserved at call start. Only then may it be emitted
   * or its tool calls dispatched. A failed commit writes none of these. */
  commitResponse(callId: string, attemptId: string, response: ModelResponse, providerRequestId?: string): StorageResult<TimelineEntry>;
  finishCall(callId: string, outcome: Exclude<CallOutcome, "running" | "succeeded">): StorageResult<void>;
  readCalls(after?: string, limit?: number): StorageResult<{ calls: ModelCallSummary[]; next?: string }>;
}
/** Live text is ephemeral. `completed` refers to committed text, inline or by
 * reference. `gap` means one or more deltas were dropped; fetch the completion. */
export type ModelTextEvent =
  | { type: "text_delta"; turnId: string; messageId: string; text: string }
  | { type: "text_gap"; turnId: string; messageId: string }
  | { type: "text_incomplete"; turnId: string; messageId: string; reason: Exclude<CallOutcome, "running" | "succeeded"> };
/** Text pages are UTF-8 bytes encoded as base64; offset is a byte offset, and
 * client concatenates bytes before UTF-8 decoding. Reads are bounded. */
export interface ModelTextPage { messageId: string; offset: number; data: string; nextOffset?: number }
/** Public reads only expose committed text and durable summaries. */
export interface ModelExecutionMethods {
  "session/model-calls": { params: { after?: string; limit?: number }; result: { calls: ModelCallSummary[]; next?: string } };
  "session/message/read": { params: { messageId: string; offset: number }; result: ModelTextPage };
}
