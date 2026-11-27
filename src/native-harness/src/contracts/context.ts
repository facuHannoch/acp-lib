import type { Message, ToolCall, ExecuteTurnTool, ToolDefinition } from "./loop.ts";
import type { LoopEvent } from "./events.ts";
import type { StorageResult, StoredTurn, TimelineEntry } from "./storage.ts";

/** Effective limits for one session. Bytes refer to UTF-8 text or serialized
 * records as documented by the relevant operation. */
export interface ContextLimits {
  readonly maxInputBytes: number;
  readonly maxTakenTextBytes: number;
  readonly maxTakenItems: number;
  readonly maxReadBytes: number;
  readonly maxReadRecords: number;
  readonly maxSharedCandidates: number;
  readonly contextTokens: number;
  readonly outputReserveTokens: number;
  readonly estimationMarginTokens: number;
}

/** Historical failure evidence associated with selected history. */
export type ContextTurnOutcome = Pick<StoredTurn, "channelId" | "turnId" | "state">;

/** Detached inputs for one build, all read at the StorageResult revision.
 * Each record list is ordered by timeline sequence. Merge required and optional
 * turn records by sequence before rendering them. Required records and complete
 * policy evidence fit in full or the read reports context_limit. */
export interface InferenceRead {
  readonly required: readonly TimelineEntry[];
  readonly optionalTurn: readonly TimelineEntry[];
  readonly localHistory: readonly TimelineEntry[];
  readonly sharedHistory: readonly TimelineEntry[];
  readonly unfinished: readonly ContextTurnOutcome[];
  /** Newly taken items in boundary order, including those taken before resume. */
  readonly takenItemIds: readonly string[];
  /** Complete policy provenance of the turn, independent of prompt trimming. */
  readonly policyNames: readonly string[];
}

/** The session storage adapter supplies the coherent bounded read. */
export interface InferenceStorageReads {
  readInferencePolicies(turnId: number, limits: ContextLimits): StorageResult<readonly string[] | { readonly code: "context_limit" }>;
  readInferenceContext(input: { channelId: string; turnId: number; limits: ContextLimits }):
    StorageResult<InferenceRead | { readonly code: "context_limit" }>;
}

/** Optional diagnostics for an assembled request. */
export interface ContextCapture {
  context: InferenceContext;
  estimatedInputBytes: number;
  budget?: ContextBudgetMeasurement;
  /** Sequence numbers of selected and trimmed candidates from the bounded read. */
  records: { included: number[]; trimmed: number[] };
  omitted: { active: number; local: number; shared: number };
}

/** Safe numeric accounting of one configured provider-equivalent request. */
export interface ContextBudgetMeasurement {
  estimator: "chat-completions-utf8-v1";
  contextWindowTokens: number;
  outputReserveTokens: number;
  estimationMarginTokens: number;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  toolDefinitionBytes: number;
  requestBytes: number;
  maxRequestBytes: number;
}

export type ContextLimitFailure =
  | { limit: "required_storage" | "provider_context" }
  | { limit: "input_tokens" | "request_bytes"; budget: ContextBudgetMeasurement };

/** The provider adapter prepares the fixed request fields once per tool offer. */
export type ContextRequestSizer = (tools: readonly ToolDefinition[]) =>
  (messages: readonly Message[]) => ContextBudgetMeasurement;

export function parseContextLimitFailure(reason: string): ContextLimitFailure | undefined {
  if (!reason.startsWith("context_limit:")) return;
  try {
    const value = JSON.parse(reason.slice("context_limit:".length));
    if (value?.limit === "required_storage" || value?.limit === "provider_context") return { limit: value.limit };
    if (!["input_tokens", "request_bytes"].includes(value?.limit) || value?.budget?.estimator !== "chat-completions-utf8-v1") return;
    const fields = ["contextWindowTokens", "outputReserveTokens", "estimationMarginTokens", "inputBudgetTokens",
      "estimatedInputTokens", "toolDefinitionBytes", "requestBytes", "maxRequestBytes"] as const;
    if (fields.some(key => !Number.isSafeInteger(value.budget[key]) || value.budget[key] < 0)) return;
    const budget = Object.fromEntries(fields.map(key => [key, value.budget[key]])) as Omit<ContextBudgetMeasurement, "estimator">;
    return { limit: value.limit, budget: { ...budget, estimator: "chat-completions-utf8-v1" } };
  } catch { return; }
}

/** One provider-neutral request. A retry reuses this capture. */
export interface InferenceContext {
  readonly sessionId: string;
  readonly channelId: string;
  readonly turnId: number;
  readonly timelineRevision: number;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly fixedToolCount?: number;
  readonly privateApprovalContext?: true;
  /** Only original input items represented in this request may get receipts. */
  readonly representedItemIds: readonly string[];
  readonly takenItemIds: readonly string[];
}

/** Size failures happen before reserving a model call or attempt. */
export type ContextBuildResult = { readonly ok: true; readonly value: InferenceContext }
  | { readonly ok: false; readonly code: "context_limit"; readonly message: string; readonly detail?: ContextLimitFailure };

/** Attributed agent experience; system instructions are configuration, not events. */
export interface ContextEntry {
  seq: number;
  at: string;
  channelId: string;
  turnId: number;
  from: string;
  kind?: "participant_message" | "channel_notice" | "external_notice";
  /** Optional host-supplied external attribution. */
  externalSource?: string;
  sourceChannelId?: string;
  message: Message;
}

/** Read-only projection of the storage timeline. Values never alias stored
 * records. Listeners run after a commit that changed the timeline. */
export interface SharedContextStore {
  snapshot(): ContextEntry[];
  subscribe(listener: () => void): () => void;
}

/** Turn-scoped operations available to the execution loop. */
export interface TurnContext {
  append(message: Message): void;
  /** The sole dispatch boundary. It records dispatch before invoking the tool,
   * invokes before publishing started to prevent reentrant cancellation, and
   * returns a paired skipped result for denial or closed approval. A test
   * barrier resolves before the last cancellation check. */
  dispatchTool(call: ToolCall, execute: ExecuteTurnTool): Promise<{ content: string; dispatched: boolean;
    /** Decision 0021: recorded with the paired result of a dispatched call. */
    outcome?: import("./tools.ts").ToolOutcome; usage?: import("./web.ts").WebResultUsage }>;
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
