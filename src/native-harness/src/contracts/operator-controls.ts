import type { ApprovalCloseReason, ApprovalRequest } from "./config-permissions.ts";
import type { ChannelChangeResult, ChannelStatusResult, ItemStatus, StoredMessage, PendingChannelChange, ProtocolConfig, TurnStatus } from "./protocol.ts";

export interface OpenResult {
  inspector?: import("./inspector.ts").InspectorStatus;
  webUnavailable?: import("./web.ts").WebUnavailable;
  mcpServers?: Record<string, import("./mcp.ts").McpServerStatus>;
  sessionId: string;
  lifecycle: import("./storage.ts").SessionLifecycle;
  revision: number;
  channelChanges?: ChannelChangeResult[];
  reminderChanges?: import("./reminders.ts").ReminderChangeResult[];
  reminders?: import("./reminders.ts").Reminder[];
  remindersNext?: string;
  nextDueAt?: string | null;
  reminderRevision?: number;
  unattendedTurnGuard?: { maxConsecutiveTurns: number } | null;
  imageInput?: true;
  imageLimits?: { formats: string[]; fileBytes: number; turnBytes: number; maxImages: number; maxSide: number; maxPixels: number };
}

export interface ChannelObservation {
  revision: number;
  sessionLifecycle: import("./storage.ts").SessionLifecycle;
  channel: Omit<ChannelStatusResult, "pending" | "unresolved"> & { pendingCount: number };
  approvals: ApprovalRequest[];
}

/** Ordered storage position scoped to a session and channel, distinct from message identity. */
export type MessagePosition = string;
type ParticipantMessage = { messageId: string; channel: string; turnId: string; parts: import("./attachments.ts").AttachmentViewPart[] };
export type ConversationMessage = (ParticipantMessage | {
  messageId: string; channel: string; turnId: string; omitted: true;
}) & { position: MessagePosition; actor: { kind: "participant"; id: string }; itemId: string } |
  ((StoredMessage | { messageId: string; channel: string; turnId: string; omitted: true }) &
    { position: MessagePosition; actor: { kind: "agent"; id: string }; itemId?: never });

export type ConversationPageRequest = { channel: string; limit?: number } & (
  | { cursor?: never; after?: never; throughRevision?: never }
  | { cursor: string; after?: never; throughRevision?: never }
  | { cursor?: never; after: MessagePosition; throughRevision: number }
);

export interface TimelineEvent {
  position: string;
  channel: string;
  turnId: string;
  actor: { kind: "participant" | "agent"; id: string };
  kind: "participant_message" | "assistant_message" | "channel_notice" | "external_notice" | "tool_call" | "tool_result";
  sourceChannel?: string;
  externalSource?: string;
  /** Stable accepted identity of an external notice. */
  itemId?: string;
  messageId?: string;
  /** Protocol bounds encoded payload bytes before publication. */
  payload?: import("./loop.ts").Message;
  omitted?: true;
  resultReference?: import("./tools.ts").ResultReference;
}

export interface OperatorMethods {
  "session/create": { params: import("./protocol.ts").CreateParams; result: OpenResult };
  "session/open": { params: LoadResultOpenParams; result: OpenResult };
  "channel/observe": { params: { channel: string }; result: ChannelObservation };
  "channel/reconcile": {
    params: { channel: string; itemIds?: string[]; turnIds?: string[]; cursor?: string };
    result: { revision: number; items: ItemStatus[]; turns: TurnStatus[]; unknownItemIds: string[]; unknownTurnIds: string[];
      replies: { messageId: string; turnId: string; position: MessagePosition }[]; next?: string };
  };
  "channel/messages": { params: ConversationPageRequest; result: { messages: ConversationMessage[]; next?: string } };
  "session/timeline": { params: { limit?: number; cursor?: string }; result: { events: TimelineEvent[]; next?: string } };
}

export interface LoadResultOpenParams {
  /** Executable owning launcher material, never saved. */
  inferenceRelayGrant?: import("./protocol.ts").InferenceRelayGrant;
  mcpRuntimeHeaders?: import("./mcp.ts").McpRuntimeHeaders;
  sessionId: string;
  config?: ProtocolConfig;
  channelChanges?: PendingChannelChange[];
  reminderChanges?: import("./reminders.ts").ReminderChange[];
  tools?: import("./tools.ts").ToolCatalogInput;
}

/** Internal read side. Results are detached and each read observes one revision.
 * Store adapters use the numeric bounds internally. Wire cursors are decoded
 * and checked by the protocol before invoking this port. */
export interface OperatorStorageReads {
  readManagedAttachment?(id: string): import("./storage.ts").StorageResult<{ metadata: import("./attachments.ts").AttachmentMetadata; timelineVisible: boolean } | undefined>;
  readChannel(channel: string): import("./storage.ts").StorageResult<{
    channel: Omit<import("./storage.ts").StoredChannel, "participantIds">;
    pendingCount: number;
    activeTurn?: Omit<import("./storage.ts").StoredTurn, "itemIds">;
  }>;
  readTracked(channel: string, itemIds: readonly string[], turnIds: readonly number[]): import("./storage.ts").StorageResult<{
    items: import("./storage.ts").StoredItem[];
    turns: import("./storage.ts").StoredTurn[];
  }>;
  readTimeline(range: {
    channel?: string;
    turnIds?: readonly number[];
    throughRevision: number;
    exclusiveSeq?: number;
    direction: "older" | "newer";
    kind: "conversation" | "timeline" | "replies";
    limit: number;
  }): import("./storage.ts").StorageResult<{ entries: import("./storage.ts").TimelineEntry[]; more: boolean }>;
}

/** Live-only signal. Observation after reconnect contains only pending requests. */
export interface ApprovalClosedEvent {
  type: "approval_closed";
  turnId: string;
  requestId: string;
  reason: ApprovalCloseReason | "dispatched";
}
