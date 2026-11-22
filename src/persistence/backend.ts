import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type { CancelOutcome, CancelReason } from "../operations/contracts.ts";
import type { OperationMeteringRecord } from "../metering/record.ts";
import type { AgentSessionMeteringState } from "../metering/state.ts";
import type { InternalInferenceRepository } from "../internal-inference/persistence/repository.ts";
import type { ConversationRecoveryCheckpointRepository } from "../checkpointing/contracts.ts";
import type { ConversationTimelineItem } from "./timeline-reconcile.ts";
import type { SharedFilesPersistence } from "../media/files.ts";
import type { MediaCaptureLevel } from "../media/capture.ts";
import type { MediaStore } from "../media/store.ts";
import type { MediaKind } from "../media/parts.ts";
import type { ChannelPersistence } from "./channels.ts";
import { contentText } from "../media/content.ts";

export type PersistenceJsonPrimitive = string | number | boolean | null;
export type PersistenceJsonValue =
  | PersistenceJsonPrimitive
  | readonly PersistenceJsonValue[]
  | { readonly [key: string]: PersistenceJsonValue };

export const PARTICIPANT_KINDS = ["agent", "user", "external"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** Reserved continuity identity used when a caller supplies no user participant ID. */
export const IMPLICIT_USER_PARTICIPANT_ID = "user:default";

export interface ParticipantRef {
  readonly id: string;
  readonly kind: ParticipantKind;
  readonly name?: string;
}

export const CONVERSATION_RECORD_KINDS = [
  "message",
  "tool_call",
  "permission",
  "configuration",
  "protocol",
  "native_action",
  "agent_action",
  "thinking",
  "activity",
  "metering",
  "error",
  "cancellation",
] as const;

export type ConversationRecordKind = (typeof CONVERSATION_RECORD_KINDS)[number];

export interface ConversationRecordEnvelope<K extends ConversationRecordKind = ConversationRecordKind> {
  readonly recordId: string;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  /** Assigned atomically by the backend and monotonic within one conversation. */
  readonly sequence: number;
  readonly kind: K;
  /** ISO-8601 instant supplied by the producer and preserved verbatim. */
  readonly timestamp: string;
  /**
   * The library operation the record was written in: a turn, an internal inference or recap, a
   * setting change, a mode change, a handoff. Every record of one operation shares it. Absent on
   * records written outside an operation (for example protocol lines while connecting).
   */
  readonly operationId?: string;
  /** Legacy envelope metadata. Older records carried the operation id here (`{"operationId": …}`). */
  readonly metadata?: string;
}

export interface PersistedMediaBlock {
  readonly type: "media";
  readonly kind: MediaKind;
  readonly mode: "copy" | "link";
  readonly ref?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly sha256?: string;
}

export type PersistedContentBlock =
  | PersistedMediaBlock
  | { readonly type: "pasted"; readonly text: string; readonly name?: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mimeType: string;
      readonly uri?: string;
      readonly data?: string;
      readonly alt?: string;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType?: string;
      readonly title?: string;
      readonly text?: string;
    }
  | { readonly type: "json"; readonly value: PersistenceJsonValue };

export type PersistedContent = string | readonly PersistedContentBlock[];

export interface MessageRecord extends ConversationRecordEnvelope<"message"> {
  readonly role: "assistant" | "user";
  /** Stable identity shared by the snapshots and final revision of one assistant message. */
  readonly logicalMessageId?: string;
  /** The local agent is implied when omitted on an assistant message. */
  readonly participantId?: string;
  /** Opaque JSON supplied by the consumer for this message only. */
  readonly consumerMetadata?: PersistenceJsonValue;
  readonly content: PersistedContent;
  readonly status?: "in_progress" | "completed" | "cancelled" | "failed";
}

export interface ToolCallRecord extends ConversationRecordEnvelope<"tool_call"> {
  readonly toolCallId: string;
  readonly state: "announced" | "input" | "completed" | "failed";
  readonly name?: string;
  readonly input?: PersistenceJsonValue;
  readonly output?: PersistedContent;
  readonly error?: string;
}

export interface PermissionRecord extends ConversationRecordEnvelope<"permission"> {
  readonly permissionId: string;
  readonly state: "requested" | "resolved";
  readonly request?: PersistenceJsonValue;
  readonly outcome?: "approved" | "denied" | "cancelled";
}

export interface ConfigurationRecord extends ConversationRecordEnvelope<"configuration"> {
  readonly operation: "set" | "restore" | "accept_effective" | "replace";
  readonly configId?: string;
  readonly value?: PersistenceJsonValue;
  readonly status: "started" | "completed" | "failed";
  readonly error?: string;
}

export interface ProtocolRecord extends ConversationRecordEnvelope<"protocol"> {
  readonly direction: "in" | "out" | "error";
  readonly method?: string;
  readonly message?: PersistenceJsonValue;
}

export interface NativeActionRecord extends ConversationRecordEnvelope<"native_action"> {
  readonly action: string;
  readonly transitionId?: string;
  readonly state: "started" | "checkpoint" | "completed" | "failed";
  readonly input?: PersistenceJsonValue;
  readonly output?: PersistenceJsonValue;
  readonly error?: string;
}

export interface AgentActionRecord extends ConversationRecordEnvelope<"agent_action"> {
  readonly action: string;
  readonly state: "requested" | "completed" | "failed";
  readonly input?: PersistenceJsonValue;
  readonly output?: PersistenceJsonValue;
  readonly error?: string;
}

export interface ThinkingRecord extends ConversationRecordEnvelope<"thinking"> {
  readonly thinkingId: string;
  readonly state: "in_progress" | "completed" | "failed";
  readonly content: PersistedContent;
}

export interface ActivityRecord extends ConversationRecordEnvelope<"activity"> {
  readonly activityId: string;
  readonly activityType: string;
  readonly state: "in_progress" | "completed" | "failed";
  readonly content?: PersistedContent;
  readonly data?: PersistenceJsonValue;
}

/** Ordered conversation-timeline pointer to the complete financial record. */
export interface MeteringReferenceRecord extends ConversationRecordEnvelope<"metering"> {
  readonly operationId: string;
  readonly meteringRecordId: string;
  readonly status: "available" | "partial" | "unavailable";
}

/** Operational boundary a conversation error was observed at. Closed taxonomy. */
export type ConversationErrorSource =
  | "provider_session"
  | "transport"
  | "operation"
  | "recovery";

/** What a consumer may reasonably do about a failed operation. */
export type ConversationErrorRecoverability =
  | "retryable"
  | "recoverable"
  | "terminal"
  | "unknown";

/** Allow-listed provider detail, retained only at raw capture. */
export interface ConversationErrorDetails {
  readonly phase?: "no_response" | "incomplete_response";
  readonly providerCode?: string | number;
  readonly rpcCode?: number;
  readonly service?: string;
  /** The provider's name for the error class (OpenCode: `APIError`). A label, not a message. */
  readonly errorName?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly transportState?: string;
}

/** Immutable, sanitized diagnosis at a meaningful conversation boundary. */
export interface ErrorRecord extends ConversationRecordEnvelope<"error"> {
  readonly source: ConversationErrorSource;
  /** Stable machine-readable value. The type stays open for future codes. */
  readonly code: string;
  readonly recoverability: ConversationErrorRecoverability;
  /** Sanitized fallback text intended for display, not a raw exception dump. */
  readonly message?: string;
  readonly operationId?: string;
  readonly transitionId?: string;
  readonly internalSessionId?: string;
  readonly details?: ConversationErrorDetails;
}

/**
 * A running operation was cancelled, whatever the mechanism (an ACP `session/cancel`, killing a
 * screen-scraped harness). One cancellation has two revisions under its `cancellationId`:
 * `requested` (when, and why) and `resolved` (how it ended). Its `operationId` is the cancelled
 * operation's.
 */
export interface CancellationRecord extends ConversationRecordEnvelope<"cancellation"> {
  readonly cancellationId: string;
  readonly state: "requested" | "resolved";
  /** `steer`: a message sent mid-turn; `interrupt`: Stop; `stalled`: the stale policy; `stop`: shutdown. */
  readonly reason: CancelReason;
  /** On `resolved` only. `too_late`: the operation finished on its own before the cancel took effect. */
  readonly outcome?: CancelOutcome;
}

export type ConversationRecord =
  | MessageRecord
  | ToolCallRecord
  | PermissionRecord
  | ConfigurationRecord
  | ProtocolRecord
  | NativeActionRecord
  | AgentActionRecord
  | ThinkingRecord
  | ActivityRecord
  | MeteringReferenceRecord
  | ErrorRecord
  | CancellationRecord;

type WithoutSequence<T> = T extends ConversationRecord ? Omit<T, "sequence"> : never;
export type NewConversationRecord = WithoutSequence<ConversationRecord>;

export type RecordCaptureLevel = "none" | "metadata" | "content" | "raw";
export type ProtocolRecordCaptureLevel = "none" | "metadata" | "raw";
export interface ProtocolRecordCaptureOptions {
  readonly level: ProtocolRecordCaptureLevel;
  /** Exact ACP method names. Methodless responses are always retained. */
  readonly includeMethods?: readonly string[];
  /** Exact ACP method names. Applied before sequence allocation. */
  readonly excludeMethods?: readonly string[];
}
export type ProtocolRecordCapture = ProtocolRecordCaptureLevel | ProtocolRecordCaptureOptions;
type NonProtocolRecordKind = Exclude<ConversationRecordKind, "protocol">;
export type ConversationRecordCaptureConfig = Readonly<
  Partial<Record<NonProtocolRecordKind, RecordCaptureLevel>> & {
    readonly protocol?: ProtocolRecordCapture;
    readonly media?: MediaCaptureLevel;
  }
>;
export type ResolvedProtocolRecordCapturePolicy = Readonly<{
  level: ProtocolRecordCaptureLevel;
  includeMethods: readonly string[];
  excludeMethods: readonly string[];
}>;
export type ConversationRecordCapturePolicy = Readonly<
  Record<NonProtocolRecordKind, RecordCaptureLevel> & {
    readonly protocol: ResolvedProtocolRecordCapturePolicy;
    readonly media: MediaCaptureLevel;
  }
>;

const DEFAULT_PROTOCOL_RECORD_CAPTURE: ResolvedProtocolRecordCapturePolicy = Object.freeze({
  level: "none",
  includeMethods: Object.freeze([]),
  excludeMethods: Object.freeze([]),
});

export const DEFAULT_CONVERSATION_RECORD_CAPTURE: ConversationRecordCapturePolicy = Object.freeze({
  message: "content",
  media: "content",
  tool_call: "metadata",
  permission: "metadata",
  configuration: "metadata",
  protocol: DEFAULT_PROTOCOL_RECORD_CAPTURE,
  native_action: "metadata",
  agent_action: "metadata",
  thinking: "none",
  activity: "metadata",
  metering: "metadata",
  error: "content",
  cancellation: "metadata",
});

export interface AgentPersistenceIdentity {
  readonly agentSessionId: AgentSessionId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: string;
}

export interface AgentConversationSummary {
  /** Absent on rows written before controller kinds were recorded. */
  readonly controllerKind?: "acp" | "native";
  readonly agentConversationId: AgentConversationId;
  readonly agentSessionId: AgentSessionId;
  readonly title?: string;
  readonly participants: readonly ParticipantRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestSequence: number;
  readonly deletedAt?: string;
  readonly metadata?: string;
  /** True when the conversation was created by adopting an existing provider session. Absent otherwise. */
  readonly adopted?: boolean;
  /** The provider session an adoption asked for, kept so a failed adoption can be retried. */
  readonly adoptProviderSessionId?: string;
}

export interface CreateAgentConversationInput {
  readonly controllerKind?: AgentConversationSummary["controllerKind"];
  readonly agentConversationId: AgentConversationId;
  readonly agentSessionId: AgentSessionId;
  readonly participants?: readonly ParticipantRef[];
  readonly title?: string;
  readonly createdAt?: string;
  readonly metadata?: string;
  /** Mark the conversation as created by adopting this provider session. */
  readonly adoptProviderSessionId?: string;
}

export interface ConversationListOptions {
  readonly participantIds?: readonly string[];
  readonly includeDeleted?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ConversationPage {
  readonly conversations: readonly AgentConversationSummary[];
  readonly nextCursor?: string;
}

export interface ConversationMessagePreview {
  readonly recordId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly role: "assistant" | "user";
  readonly participantId?: string;
  readonly text: string;
}

export interface AgentConversationPreview {
  readonly conversation: AgentConversationSummary;
  readonly latestMessage?: ConversationMessagePreview;
  readonly lastHumanMessageAt?: string;
}

export interface ConversationPreviewPage {
  readonly previews: readonly AgentConversationPreview[];
  readonly nextCursor?: string;
}

export interface RecordListOptions {
  readonly kinds?: readonly ConversationRecordKind[];
  /** Only the records of this operation (a turn's `operationId`, for example). */
  readonly operationId?: string;
  readonly afterSequence?: number;
  readonly throughSequence?: number;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ConversationRecordPage {
  readonly records: readonly ConversationRecord[];
  readonly nextCursor?: string;
}

/** Newest matching records at a fixed conversation-sequence snapshot, oldest-first within each page. */
export interface RecentRecordPageOptions {
  readonly kinds?: readonly ConversationRecordKind[];
  /**
   * Without `agentMessages`, the records per page (default 50, at most 500). With it, the most a
   * page holds (records, or items when folded; default 2000, at most 10000): a page that reaches it
   * ends early with `truncated`.
   */
  readonly limit?: number;
  readonly olderCursor?: string;
  /**
   * Page by agent messages: each page holds this many agent messages and the activity that led to
   * each. A record goes to the page where its item's first revision falls, so a page holds every
   * revision of its items and none of another page's.
   */
  readonly agentMessages?: number;
  /** `summary` leaves out tool calls' input and output; `records.get(recordId)` returns them. */
  readonly detail?: "full" | "summary";
  /** `true` returns timeline items instead of records. */
  readonly fold?: false;
}

export interface RecentItemPageOptions extends Omit<RecentRecordPageOptions, "fold"> {
  readonly fold: true;
}

export interface RecentRecordPage {
  readonly records: readonly ConversationRecord[];
  readonly snapshotSequence: number;
  readonly olderCursor?: string;
  /** The page reached `limit` before its last agent message; the next page continues from there. */
  readonly truncated?: true;
}

/**
 * Recent history as timeline items, merged as `reconcileConversationTimeline` does. With
 * `detail: "summary"` an item keeps two revisions, its first and its merged current, so it still
 * reconciles with later records.
 */
export interface RecentItemPage {
  readonly items: readonly ConversationTimelineItem[];
  readonly snapshotSequence: number;
  readonly olderCursor?: string;
  readonly truncated?: true;
}

export interface MessageListOptions {
  readonly afterSequence?: number;
  readonly throughSequence?: number;
  readonly participantIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MessagePage {
  readonly messages: readonly MessageRecord[];
  readonly nextCursor?: string;
}

export interface ConversationRuntimeCheckpoint {
  readonly agentConversationId: AgentConversationId;
  readonly revision: number;
  readonly coveredSequence: number;
  readonly state: PersistenceJsonValue;
  readonly updatedAt: string;
}

export interface ProviderSessionRecord {
  readonly providerSessionRecordId: string;
  readonly agentConversationId: AgentConversationId;
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly model?: string;
  readonly activatedAt: string;
  readonly deactivatedAt?: string;
  readonly transitionId?: string;
  readonly metadata?: string;
}

export interface SearchQuery {
  readonly text: string;
  readonly conversationIds?: readonly AgentConversationId[];
  readonly participantIds?: readonly string[];
  readonly kinds?: readonly ConversationRecordKind[];
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface SearchMatch {
  readonly recordId: string;
  readonly agentConversationId: AgentConversationId;
  readonly sequence: number;
  readonly kind: ConversationRecordKind;
  /** Backend-specific relevance where lower or higher is not assumed by consumers. */
  readonly score: number;
  readonly snippet?: string;
}

export interface IdentityMemoryObservation {
  readonly memoryId: string;
  readonly agentSessionId: AgentSessionId;
  readonly sequence: number;
  readonly sourceConversationId: AgentConversationId;
  readonly sourceRecordIds: readonly string[];
  readonly participantId?: string;
  readonly kind: string;
  readonly content: PersistenceJsonValue;
  readonly createdAt: string;
  readonly metadata?: string;
}

export type NewIdentityMemoryObservation = Omit<IdentityMemoryObservation, "sequence">;

export interface PersistedIdentitySnapshot {
  readonly snapshotId: string;
  readonly agentSessionId: AgentSessionId;
  readonly version: number;
  readonly processedThroughSequence: number;
  readonly value: PersistenceJsonValue;
  readonly createdAt: string;
}

export interface IdentityProjectionState {
  readonly agentSessionId: AgentSessionId;
  readonly observedThroughSequence: number;
  readonly processedThroughSequence: number;
  readonly activeSnapshotId?: string;
}

/** What one provider context has already received from another conversation. */
export interface IdentityDeliveryCursor {
  readonly targetConversationId: AgentConversationId;
  readonly targetProviderContextId: string;
  readonly sourceConversationId: AgentConversationId;
  readonly deliveredThroughSequence: number;
  readonly updatedAt: string;
}

export type IdentityDeliveryAdvance = Omit<IdentityDeliveryCursor, "updatedAt">;

export interface AuditOutboxItem {
  readonly outboxId: string;
  readonly auditSequence: number;
  readonly sourceObservationId: string;
  readonly sourceRecordId?: string;
  readonly operationId?: string;
  readonly agentConversationId?: AgentConversationId;
  readonly occurredAt: string;
  readonly kind: string;
  readonly captureLevel: string;
  readonly captureFingerprint: string;
  readonly payload: PersistenceJsonValue;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly createdAt: string;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly lastError?: string;
}

export type NewAuditOutboxItem = Omit<
  AuditOutboxItem,
  | "auditSequence"
  | "payloadSha256"
  | "payloadBytes"
  | "attemptCount"
  | "nextAttemptAt"
  | "lastError"
>;

export interface AgentAuditState {
  readonly auditLogId: string;
  readonly lastAllocatedSequence: number;
  readonly lastDeliveredSequence: number;
  readonly captureFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditOutboxBacklog {
  readonly pendingCount: number;
  readonly pendingPayloadBytes: number;
  readonly oldestPendingAt?: string;
}

export interface PersistenceExtensionRegistration {
  readonly extensionId: string;
  readonly schemaVersion: number;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface ConversationPersistence {
  create(input: CreateAgentConversationInput): Promise<AgentConversationSummary>;
  get(agentConversationId: AgentConversationId): Promise<AgentConversationSummary | null>;
  list(options?: ConversationListOptions): Promise<ConversationPage>;
  /** Optional batched conversation-list projection for SQLite-backed agents. */
  listPreviews?(options?: ConversationListOptions): Promise<ConversationPreviewPage>;
  renameParticipant(
    agentConversationId: AgentConversationId,
    participantId: string,
    name: string | undefined,
  ): Promise<void>;
  ensureParticipant(
    agentConversationId: AgentConversationId,
    participant: ParticipantRef,
  ): Promise<ParticipantRef>;
  delete(agentConversationId: AgentConversationId, deletedAt?: string): Promise<void>;
}

export interface ConversationRecordPersistence {
  append(record: NewConversationRecord): Promise<ConversationRecord>;
  appendMany(records: readonly NewConversationRecord[]): Promise<readonly ConversationRecord[]>;
  get(recordId: string): Promise<ConversationRecord | null>;
  list(
    agentConversationId: AgentConversationId,
    options?: RecordListOptions,
  ): Promise<ConversationRecordPage>;
  /**
   * Physically delete every record of a conversation, keeping the conversation itself. Returns how many were
   * deleted. Sequence numbers are not reused. Optional: an append-only backend cannot clear a transcript.
   */
  deleteForConversation?(agentConversationId: AgentConversationId): Promise<number>;
  /** Optional efficient newest-first history API. Use list(afterSequence) for live catch-up. */
  listRecent?(
    agentConversationId: AgentConversationId,
    options: RecentItemPageOptions,
  ): Promise<RecentItemPage>;
  listRecent?(
    agentConversationId: AgentConversationId,
    options?: RecentRecordPageOptions,
  ): Promise<RecentRecordPage>;
}

export interface ConversationMessagePersistence {
  list(
    agentConversationId: AgentConversationId,
    options?: MessageListOptions,
  ): Promise<MessagePage>;
}

export interface ConversationCheckpointPersistence {
  get(agentConversationId: AgentConversationId): Promise<ConversationRuntimeCheckpoint | null>;
  put(
    checkpoint: ConversationRuntimeCheckpoint,
    expectedRevision?: number,
  ): Promise<ConversationRuntimeCheckpoint>;
}

export interface ProviderSessionPersistence {
  append(record: ProviderSessionRecord): Promise<void>;
  list(agentConversationId: AgentConversationId): Promise<readonly ProviderSessionRecord[]>;
  active(agentConversationId: AgentConversationId): Promise<ProviderSessionRecord | null>;
  /**
   * Conversations that own this provider session: those where it is the active session, and those
   * that asked to adopt it and have not attached it yet. Deleted conversations do not count.
   * Optional: a backend without it cannot refuse a second adoption of the same session.
   */
  conversationsUsing?(internalSessionId: string): Promise<readonly AgentConversationId[]>;
}

export type MeteringRecordRetention = "all" | "none" | { readonly retain: number };

export interface PersistedConversationMeteringState {
  readonly agentConversationId: AgentConversationId;
  readonly revision: number;
  readonly state: AgentSessionMeteringState;
  readonly updatedAt: string;
}

export interface MeteringCommitInput {
  readonly agentConversationId: AgentConversationId;
  readonly record: OperationMeteringRecord;
  readonly meteringRecords: MeteringRecordRetention;
  readonly updatedAt?: string;
}

export interface PersistedAgentMeteringState {
  readonly agentSessionId: AgentSessionId;
  readonly revision: number;
  readonly state: AgentSessionMeteringState;
  readonly updatedAt: string;
}

export interface AgentMeteringCommitInput {
  readonly agentSessionId: AgentSessionId;
  readonly record: OperationMeteringRecord;
  readonly meteringRecords: MeteringRecordRetention;
  readonly updatedAt?: string;
}

export interface MeteringRecordListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MeteringRecordPage {
  readonly records: readonly OperationMeteringRecord[];
  readonly nextCursor?: string;
}

export interface MeteringPersistence {
  /** Atomically deduplicate the operation and advance its bounded restoration state. */
  commit(input: MeteringCommitInput): Promise<PersistedConversationMeteringState>;
  saveState(
    agentConversationId: AgentConversationId,
    state: AgentSessionMeteringState,
    updatedAt?: string,
  ): Promise<PersistedConversationMeteringState>;
  state(agentConversationId: AgentConversationId): Promise<PersistedConversationMeteringState | null>;
  list(
    agentConversationId: AgentConversationId,
    options?: MeteringRecordListOptions,
  ): Promise<MeteringRecordPage>;
  get(
    agentConversationId: AgentConversationId,
    operationId: string,
  ): Promise<OperationMeteringRecord | null>;
  /** Agent-level scope for internal work that was not caused by a conversation. */
  commitAgent(input: AgentMeteringCommitInput): Promise<PersistedAgentMeteringState>;
  agentState(agentSessionId: AgentSessionId): Promise<PersistedAgentMeteringState | null>;
  listAgent(
    agentSessionId: AgentSessionId,
    options?: MeteringRecordListOptions,
  ): Promise<MeteringRecordPage>;
  getAgent(agentSessionId: AgentSessionId, operationId: string): Promise<OperationMeteringRecord | null>;
}

export interface SearchPersistence {
  search(query: SearchQuery): Promise<readonly SearchMatch[]>;
  rebuild(): Promise<void>;
  integrityCheck(): Promise<void>;
}

export interface IdentityPersistence {
  append(
    observations: readonly NewIdentityMemoryObservation[],
  ): Promise<readonly IdentityMemoryObservation[]>;
  listAfter(sequence: number, limit?: number): Promise<readonly IdentityMemoryObservation[]>;
  latestSnapshot(): Promise<PersistedIdentitySnapshot | null>;
  publishSnapshot(
    snapshot: PersistedIdentitySnapshot,
    expectedVersion?: number,
  ): Promise<void>;
  projectionState(): Promise<IdentityProjectionState>;
}

export interface IdentityDeliveryPersistence {
  get(
    targetConversationId: AgentConversationId,
    targetProviderContextId: string,
    sourceConversationId: AgentConversationId,
  ): Promise<IdentityDeliveryCursor | null>;
  advance(updates: readonly IdentityDeliveryAdvance[]): Promise<void>;
  /** A newly created provider context may reuse an opaque provider session ID. */
  reset(targetConversationId: AgentConversationId, targetProviderContextId: string): Promise<void>;
}

export interface AuditOutboxPersistence {
  initialize(auditLogId: string, captureFingerprint: string, now?: string): Promise<AgentAuditState>;
  state(): Promise<AgentAuditState | null>;
  backlog(): Promise<AuditOutboxBacklog>;
  enqueue(item: NewAuditOutboxItem): Promise<AuditOutboxItem>;
  head(): Promise<AuditOutboxItem | null>;
  pending(limit?: number, now?: string): Promise<readonly AuditOutboxItem[]>;
  acknowledge(outboxIds: readonly string[], deliveredAt?: string): Promise<AgentAuditState>;
  markFailed(outboxId: string, error: string, nextAttemptAt?: string): Promise<void>;
  retryHead(): Promise<void>;
}

export interface PersistenceExtensionCatalog {
  get(extensionId: string): Promise<PersistenceExtensionRegistration | null>;
  list(): Promise<readonly PersistenceExtensionRegistration[]>;
}

export interface PersistenceCapabilities {
  readonly transactions: true;
  readonly fullTextSearch: boolean;
  readonly identity: boolean;
  readonly channels: boolean;
  readonly auditOutbox: boolean;
  readonly extensions: boolean;
  readonly vectorSearch: boolean;
  readonly metering: boolean;
}

export interface OutOfBandDeliveryPersistence {
  get(owner: AgentConversationId, providerContext: string): Promise<number>;
  advance(owner: AgentConversationId, providerContext: string, throughSequence: number): Promise<void>;
}

export interface PersistenceScope {
  readonly files?: SharedFilesPersistence;
  readonly outOfBandDelivery?: OutOfBandDeliveryPersistence;
  readonly media?: MediaStore;
  readonly conversations: ConversationPersistence;
  readonly records: ConversationRecordPersistence;
  readonly messages: ConversationMessagePersistence;
  readonly checkpoints: ConversationCheckpointPersistence;
  readonly providerSessions: ProviderSessionPersistence;
  readonly metering: MeteringPersistence;
  readonly internalInferences?: InternalInferenceRepository;
  readonly recoveryCheckpoints?: ConversationRecoveryCheckpointRepository;
  readonly identity?: IdentityPersistence;
  readonly channels?: ChannelPersistence;
  readonly identityDelivery?: IdentityDeliveryPersistence;
  readonly search?: SearchPersistence;
  readonly auditOutbox?: AuditOutboxPersistence;
  readonly extensions?: PersistenceExtensionCatalog;
}

export interface PersistenceBackend extends PersistenceScope {
  readonly identityRecord: AgentPersistenceIdentity;
  readonly capabilities: PersistenceCapabilities;
  transaction<T>(work: (transaction: PersistenceScope) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PersistenceExtensionMigrationContext {
  readonly extensionId: string;
  readonly installedVersion: number;
  execute(sql: string, parameters?: readonly PersistenceJsonPrimitive[]): Promise<void>;
}

export interface PersistenceExtension {
  readonly id: string;
  readonly version: number;
  migrate(context: PersistenceExtensionMigrationContext): Promise<void>;
  recordsCommitted?(records: readonly ConversationRecord[]): Promise<void>;
}

export interface VectorSearchQuery {
  readonly embedding: readonly number[];
  readonly limit?: number;
  readonly conversationIds?: readonly AgentConversationId[];
  readonly participantIds?: readonly string[];
}

export interface VectorSearchMatch {
  readonly memoryId: string;
  readonly distance: number;
}

export interface VectorIndex {
  upsert(
    values: readonly {
      readonly memoryId: string;
      readonly modelId: string;
      readonly embedding: readonly number[];
    }[],
  ): Promise<void>;
  remove(memoryIds: readonly string[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<readonly VectorSearchMatch[]>;
}

export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class PersistenceCapabilityError extends Error {
  constructor(capability: keyof PersistenceCapabilities) {
    super(`persistence capability is unavailable: ${capability}`);
    this.name = "PersistenceCapabilityError";
  }
}

export function isParticipantKind(value: unknown): value is ParticipantKind {
  return typeof value === "string" && PARTICIPANT_KINDS.includes(value as ParticipantKind);
}

export function normalizeParticipantRef(participant: ParticipantRef): ParticipantRef {
  const id = participant.id.trim();
  if (!id) throw new Error("participant id cannot be blank");
  if (!isParticipantKind(participant.kind)) {
    throw new Error(`unsupported participant kind: ${String(participant.kind)}`);
  }
  const name = participant.name?.trim();
  return Object.freeze({
    id,
    kind: participant.kind,
    ...(name ? { name } : {}),
  });
}

export function isConversationRecordKind(value: unknown): value is ConversationRecordKind {
  return typeof value === "string"
    && CONVERSATION_RECORD_KINDS.includes(value as ConversationRecordKind);
}

export function resolveConversationRecordCapture(
  override: ConversationRecordCaptureConfig = {},
): ConversationRecordCapturePolicy {
  const resolved: Record<string, unknown> = { ...DEFAULT_CONVERSATION_RECORD_CAPTURE };
  for (const [kind, value] of Object.entries(override)) {
    if (kind === "media") {
      if (!["none", "metadata", "content"].includes(String(value))) {
        throw new Error(`invalid media capture level: ${String(value)}`);
      }
      resolved.media = value;
      continue;
    }
    if (!isConversationRecordKind(kind)) throw new Error(`unknown record capture kind: ${kind}`);
    if (kind === "protocol") {
      resolved.protocol = resolveProtocolRecordCapture(value as ProtocolRecordCapture);
      continue;
    }
    if (!["none", "metadata", "content", "raw"].includes(String(value))) {
      throw new Error(`invalid capture level for ${kind}: ${String(value)}`);
    }
    resolved[kind] = value as RecordCaptureLevel;
  }
  return Object.freeze(resolved) as ConversationRecordCapturePolicy;
}

export function shouldCaptureProtocolMethod(
  policy: ResolvedProtocolRecordCapturePolicy,
  method: string | undefined,
): boolean {
  if (!method) return true;
  if (policy.excludeMethods.includes(method)) return false;
  return policy.includeMethods.length === 0 || policy.includeMethods.includes(method);
}

function resolveProtocolRecordCapture(
  value: ProtocolRecordCapture,
): ResolvedProtocolRecordCapturePolicy {
  if (typeof value === "string") {
    if (!["none", "metadata", "raw"].includes(value)) {
      throw new Error(`invalid capture level for protocol: ${value}`);
    }
    return Object.freeze({
      level: value as ProtocolRecordCaptureLevel,
      includeMethods: Object.freeze([]),
      excludeMethods: Object.freeze([]),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid protocol capture policy");
  }
  for (const key of Object.keys(value)) {
    if (!["level", "includeMethods", "excludeMethods"].includes(key)) {
      throw new Error(`unknown protocol capture option: ${key}`);
    }
  }
  if (!["none", "metadata", "raw"].includes(String(value.level))) {
    throw new Error(`invalid capture level for protocol: ${String(value.level)}`);
  }
  const includeMethods = normalizeProtocolMethods(value.includeMethods, "includeMethods");
  const excludeMethods = normalizeProtocolMethods(value.excludeMethods, "excludeMethods");
  if (includeMethods.length && excludeMethods.length) {
    throw new Error("protocol capture cannot combine includeMethods and excludeMethods");
  }
  return Object.freeze({
    level: value.level,
    includeMethods,
    excludeMethods,
  });
}

function normalizeProtocolMethods(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`protocol capture ${field} must be an array`);
  const methods = value.map((method) => {
    if (typeof method !== "string" || !method.trim()) {
      throw new Error(`protocol capture ${field} contains a blank method`);
    }
    return method.trim();
  });
  if (new Set(methods).size !== methods.length) {
    throw new Error(`protocol capture ${field} contains duplicate methods`);
  }
  return Object.freeze(methods);
}

/** Text projection for one record. Record boundaries remain separate search documents. */
export function searchableText(record: ConversationRecord): string {
  switch (record.kind) {
    case "message":
    case "thinking":
      return contentText(record.content);
    case "tool_call":
      return [record.name, jsonText(record.input), contentText(record.output)].filter(Boolean).join("\n");
    case "permission":
      return [jsonText(record.request), record.outcome].filter(Boolean).join("\n");
    case "configuration":
      return [record.operation, record.configId, jsonText(record.value), record.error].filter(Boolean).join("\n");
    case "protocol":
      return [record.method, jsonText(record.message)].filter(Boolean).join("\n");
    case "native_action":
    case "agent_action":
      return [record.action, jsonText(record.input), jsonText(record.output), record.error].filter(Boolean).join("\n");
    case "activity":
      return [record.activityType, contentText(record.content), jsonText(record.data)].filter(Boolean).join("\n");
    case "metering":
      return [record.operationId, record.meteringRecordId, record.status].join("\n");
    case "error":
      // Errors are operational history, not searchable conversation content; v1 keeps them
      // out of full-text search.
    case "cancellation":
      return "";
  }
}


function jsonText(value: PersistenceJsonValue | undefined): string {
  return value === undefined ? "" : JSON.stringify(value);
}
