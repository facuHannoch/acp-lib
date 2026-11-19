import type { ChannelEvent, SessionEvent } from "./events.ts";
import type { ItemKind, ItemMilestone } from "./agent.ts";

export interface Subscription { text: "final"; tools: "none" | "summary" | "full" }
export interface InitializeParams {
  protocolVersion: number;
  host: { name: string; version: string };
  callbacks: string[];
  subscription: Subscription;
}
export interface ProtocolConfig {
  version: 1;
  system: string;
  model: { protocol: "scripted"; script: string };
}
export interface CreateParams {
  sessionId: string;
  config: ProtocolConfig;
  participants: { id: string; kind: "person" | "agent" | "worker" | "host" }[];
  channels: Record<string, never>;
}
export interface PushParams {
  channel: string;
  item: { id: string; kind: "user_message"; sender: string; content: { type: "text"; text: string }[]; delivery?: "queue"; wake?: true };
}
export interface Description {
  configOptions: unknown[]; commands: unknown[]; policies: string[];
  /** Advertise only implemented guarantees: `durable`/`true` are reported by a
   * server only once its acceptance commits to storage before acknowledging. */
  capabilities: { experimental: true; acceptance: "memory" | "durable"; methods: string[]; events: string[]; persistence: boolean };
}

// ---- Durable operations, decision 0013. A server lists a method in
// capabilities.methods only when it implements it.

/** Stable `error.data.code` values added by decision 0013. `item_conflict`
 * already exists. A lifecycle refusal never consumes or alters accepted work. */
export type DurableErrorCode =
  | "item_conflict" | "not_running" | "stopped" | "invalid_state" | "incompatible"
  | "owner_conflict" | "not_found" | "already_exists" | "busy"
  | "invalid_archive" | "transfer_limit" | "storage_failure";

/** Wire view of an accepted input. `turnId` is present from `taken` onward. */
export interface ItemStatus {
  id: string; channel: string; kind: ItemKind; sender: string;
  milestone: ItemMilestone; turnId?: string;
}
export interface TurnStatus {
  turnId: string; channel: string; items: string[];
  state: "running" | "suspended" | "completed" | "failed" | "interrupted";
  reason?: string;
  /** Recorded calls with no recorded result; never replayed by the harness. */
  uncertainCalls?: string[];
}
/** `idle`, `suspended` and unresolved interrupted work are distinguishable:
 * see SessionStatus in the session contract for the exact derivation. */
export interface StatusResult {
  sessionId: string; revision: number;
  lifecycle: "running" | "suspending" | "suspended";
  execution: "idle" | "working" | "suspending" | "suspended" | "stopped";
  channels: { channel: string; activeTurn?: { turnId: string; state: "running" | "suspended" };
    pending: string[]; unresolved?: TurnStatus }[];
}
export interface StoredMessage { messageId: string; channel: string; turnId: string; parts: { type: "text"; text: string }[] }

/** One consistent view at `status.revision`. Ordering guarantee on a
 * connection: every event whose commit is included in this revision was
 * published before this response or is not published at all; every later
 * event (revision greater than `status.revision`) follows the response. The
 * server makes pending input eligible for execution only after writing the
 * response, so live events for recovered work always come after it. Loading
 * never resumes a suspended session. `messages` holds committed assistant
 * text in timeline order, up to `messagesLimit`; `nextMessage` continues with
 * `session/messages`, which stays anchored to the same revision.
 * Only messages are paged. If `status`, `turns` and `items` together, or any
 * single message record, cannot be sent within MAX_FRAME_BYTES (1 MiB), the
 * request fails `transfer_limit` and no partial result is returned. */
export interface LoadResult {
  status: StatusResult;
  turns: TurnStatus[];
  items: ItemStatus[];
  messages: StoredMessage[];
  nextMessage?: string;
}

/** Archive bytes move by path when host and harness share a filesystem, or by
 * a bounded transfer otherwise. Data is base64 of at most `chunkBytes` raw
 * bytes so every frame stays under the 1 MiB stdio bound. One transfer may be
 * open per connection. A transfer's temporary file is deleted when it is
 * closed, consumed by import, idle past `idleMs`, or its connection ends.
 * An archive larger than `maxBytes` fails `transfer/open` and `session/export`
 * (path or transfer) with `transfer_limit`, leaving no partial or temporary file. */
export interface TransferLimits { chunkBytes: 524288; maxBytes: 268435456; idleMs: 60000 }
export type ArchiveLocation = { type: "path"; path: string } | { type: "transfer" };

export interface DurableMethods {
  /** Open an existing session with runtime configuration. Returns the load
   * view; a second load on the same endpoint returns a fresh view only. */
  "session/load": { params: { sessionId: string; config: ProtocolConfig; messagesLimit?: number }; result: LoadResult };
  /** Only records committed at or before `revision`, after message `after`.
   * `not_found` for a revision the session has not reached. */
  "session/messages": { params: { revision: number; after: string; limit?: number }; result: { messages: StoredMessage[]; nextMessage?: string } };
  "session/status": { params: Record<string, never>; result: StatusResult };
  /** Responds after `suspended` commits. Repeating it is harmless. Fails
   * `stopped` if the session is stopped before suspension commits. */
  "session/suspend": { params: Record<string, never>; result: StatusResult };
  /** Explicit; fails `incompatible` without consuming input or checkpoints. */
  "session/resume": { params: Record<string, never>; result: StatusResult };
  /** Immediate stop; active turns, including turns checkpointed by an
   * unfinished suspension, are reported interrupted. Stdin EOF does the same. */
  "session/stop": { params: Record<string, never>; result: StatusResult };
  /** Allowed when idle with nothing pending, or suspended; else `busy`. For
   * `transfer` the result names a readable transfer. */
  "session/export": { params: { to: ArchiveLocation }; result: { bytes: number; sha256: string; transferId?: string } };
  /** Validate fully, then publish atomically into a fresh home. Does not load,
   * start or resume the copy. `from.transfer` names a completed upload. */
  "session/import": { params: { from: { type: "path"; path: string } | { type: "transfer"; transferId: string }; sessionId?: string };
    result: { sessionId: string; lifecycle: "running" | "suspended"; revision: number } };
  "transfer/open": { params: { bytes: number; sha256: string }; result: { transferId: string; limits: TransferLimits } };
  /** Offsets are sequential; a gap, overrun or oversize chunk is `transfer_limit`. */
  "transfer/write": { params: { transferId: string; offset: number; data: string }; result: { received: number } };
  "transfer/read": { params: { transferId: string; offset: number }; result: { data: string; eof: boolean } };
  "transfer/close": { params: { transferId: string }; result: Record<string, never> };
}
/** Sent after its lifecycle commit, on the same ordered stream as channel
 * events. Delivered through `subscribeSession` on the transport and endpoint. */
export interface RpcSessionNotification { jsonrpc: "2.0"; method: "session/event"; params: SessionEvent }
export interface Methods {
  initialize: { params: InitializeParams; result: { protocolVersion: 1; harness: { version: string }; description: Description } };
  "session/create": { params: CreateParams; result: { sessionId: string } };
  /** With durable acceptance the response is sent only after the inbox commit
   * and includes `item` (Received, or the original item's current state for a
   * retry). It never waits for or reports a reply. There is one delivery
   * behavior: `delivery` and `wake` are accepted for compatibility and ignored. */
  "channel/push": { params: PushParams; result: { accepted: true; item?: ItemStatus; duplicate?: boolean } };
  "session/idle": { params: Record<string, never>; result: { idle: boolean } };
}
export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: unknown }
export type RpcResponse = { jsonrpc: "2.0"; id: number; result: unknown } |
  { jsonrpc: "2.0"; id: number | null; error: { code: number; message: string; data: { code: string } } };
export interface RpcNotification { jsonrpc: "2.0"; method: "channel/event"; params: ChannelEvent }
/** Transport carries envelopes; client owns correlation and request timeouts. */
export interface ClientTransport {
  send(request: RpcRequest): void;
  subscribe(listener: (message: RpcResponse | RpcNotification) => void): () => void;
  /** Decision 0013: required of every transport once `session/event` is listed
   * in capabilities. A transport must route `session/event` here and never to
   * `subscribe`. Relative order with channel events and responses is the wire
   * order. Optional only until the transports implement it. */
  subscribeSession?(listener: (notification: RpcSessionNotification) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
}

/** Host owns process creation and termination; transport owns protocol IO only. */
export interface StdioConnection {
  readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  end(): void | Promise<void>;
  exited?: Promise<number>;
}
export interface ProtocolEndpoint {
  request(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (notification: RpcNotification) => void): () => void;
  /** Lifecycle notifications, published after their commit. See ClientTransport. */
  subscribeSession?(listener: (notification: RpcSessionNotification) => void): () => void;
}
