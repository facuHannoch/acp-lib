import type { OperatorMethods } from "./operator-controls.ts";
import type { ModelExecutionMethods } from "./model-execution.ts";
import type { ChannelEvent, SessionEvent } from "./events.ts";
import type { ItemKind, ItemMilestone } from "./agent.ts";

export interface Subscription { text: "final" | "stream"; tools: "none" | "summary" | "full" }
export interface InitializeParams {
  protocolVersion: number;
  host: { name: string; version: string };
  /** Empty, or `["functions/call"]` (decision 0021) to receive callbacks. */
  callbacks: string[];
  approval?: boolean;
  /** Decision 0021: the handler names this connection serves. A catalog tool
   * whose handler is missing here is unavailable. */
  functions?: string[];
  subscription: Subscription;
}
export interface ProtocolConfig {
  version: 1;
  system: string;
  model: import("./config-permissions.ts").ManagedModel;
  defaultPolicy?: string;
  policies?: Record<string, import("./config-permissions.ts").ToolPolicy>;
}
export interface CreateParams {
  sessionId: string;
  config?: ProtocolConfig;
  participants: { id: string; kind: "person" | "agent" | "worker" | "host" }[];
  channels: Record<string, never>;
  /** Decision 0020. Applied before the new session starts. */
  channelChanges?: PendingChannelChange[];
  /** Decision 0021. Bound before the session starts. */
  tools?: import("./tools.ts").ToolCatalogInput;
}
/** Owning host submission. policyNames is a set of user-facing names, including an explicit empty set. */
export interface NotifyParams {
  channel: string;
  notice: { id: string; text: string; source?: string; policyNames: string[] };
}
export interface PushParams {
  channel: string;
  item: { id: string; kind: "user_message"; sender: string; content: { type: "text"; text: string }[]; policy?: string | null; delivery?: "queue"; wake?: true };
}
export interface Description {
  configOptions: unknown[]; commands: unknown[]; policies: string[];
  /** Advertise only implemented guarantees: `durable`/`true` are reported by a
   * server only once its acceptance commits to storage before acknowledging. */
  capabilities: { experimental: true; acceptance: "memory" | "durable"; methods: string[]; events: string[]; persistence: boolean;
    /** Decision 0020: `session/create` and `session/open` accept `channelChanges`
     * and apply them before the session starts. Absent on older servers, which
     * reject the field. */
    startupChannelChanges?: true;
    /** Decision 0021: tool catalogs, `functions/call` callbacks and invocation records. */
    functions?: true };
}

// ---- Channel changes applied at open, decision 0020.

/** The host's newest desired state for one channel, decided while the harness
 * was not running. A missing field leaves the value alone; `null` clears a
 * name or policy. An unknown channel is created. `changeId` is opaque to the
 * harness and echoed in the result so the host can match its own version. */
export interface PendingChannelChange {
  channel: string;
  changeId: string;
  displayName?: string | null;
  policy?: string | null;
  /** `open` clears the channel's own suspension (never the session's);
   * `suspended` suspends it; `retired` deletes it. */
  lifecycle?: "open" | "suspended" | "retired";
}
/** One per batch entry, in request order. `blocked` wrote neither name nor
 * policy and left the lifecycle as it was, with one exception: `channel_busy`
 * (retirement found pending input or a running or checkpointed turn) durably
 * suspends the channel and keeps its work. `channel_retired`: the ID is
 * retired and the entry asked for something other than retirement.
 * `incompatible`: the resume would continue work the current configuration
 * cannot run; the channel stays suspended. */
export interface ChannelChangeResult {
  channel: string;
  changeId: string;
  outcome: "applied" | "blocked";
  reason?: "channel_busy" | "channel_retired" | "incompatible";
}

// ---- Durable operations, decision 0013. A server lists a method in
// capabilities.methods only when it implements it.

/** Stable `error.data.code` values added by decision 0013. `item_conflict`
 * already exists. A lifecycle refusal never consumes or alters accepted work. */
export type DurableErrorCode =
  | "item_conflict" | "not_running" | "stopped" | "invalid_state" | "incompatible"
  | "owner_conflict" | "not_found" | "already_exists" | "busy"
  | "invalid_archive" | "invalid_policy" | "transfer_limit" | "serialization_error" | "storage_failure"
  /** Decision 0014. The channel is suspending or suspended; a retry of accepted input still returns its recorded outcome. */
  | "channel_suspended"
  /** The channel ID was deleted; it is reserved for good. */
  | "channel_retired"
  /** Deletion refused: active or checkpointed turn, or pending input. */
  | "channel_busy";

/** Wire view of an accepted input. `turnId` is present from `taken` onward and
 * absent for `withdrawn`. */
export interface ItemStatus {
  id: string; channel: string; kind: ItemKind; sender: string;
  milestone: ItemMilestone; turnId?: string;
  policy?: import("./config-permissions.ts").ItemPolicy;
  externalSource?: string;
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
  execution: "idle" | "working" | "suspending" | "suspended" | "stopped" | "incompatible";
  channels: ChannelStatusResult[];
}
/** Decision 0014: channel lifecycle, turn status and pending input are
 * independent. `pending` excludes withdrawn items. `waitingForResume` is true
 * when pending items or a checkpoint exist that cannot run until a resume
 * (channel or session); such work never makes `execution` `working`. A server
 * from before decision 0014 omits `lifecycle` and `waitingForResume`: read as
 * `open` and false. */
export interface ChannelStatusResult {
  channel: string; displayName?: string; policy?: string;
  lifecycle: "open" | "suspending" | "suspended" | "retired";
  /** `phase` (decision 0021) says what a running turn is doing and since when. */
  activeTurn?: { turnId: string; state: "running" | "suspended"; phase?: import("./tools.ts").TurnPhase };
  pending: string[]; waitingForResume: boolean; unresolved?: TurnStatus;
}
export type StoredMessage = { messageId: string; channel: string; turnId: string } &
  ({ parts: { type: "text"; text: string }[]; reference?: never } | { parts?: never; reference: true });

/** Internal view retained for development and test projections. The wire uses OpenResult and focused reads. */
export interface LoadResult {
  status: StatusResult;
  turns: TurnStatus[];
  items: ItemStatus[];
  messages: StoredMessage[];
  nextMessage?: string;
  /** Decision 0020: results of the batch this connection's open applied.
   * Present when a batch was sent with this open or recorded by it. */
  channelChanges?: ChannelChangeResult[];
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

export interface DurableMethods extends ModelExecutionMethods, Omit<OperatorMethods, "session/create"> {
  /** Open an existing session with runtime configuration. Returns the load
   * view; a second load on the same endpoint returns a fresh view only.
   * `channelChanges` (decision 0020) is validated as a whole, then applied
   * after recovery and before any pending or recovered work becomes eligible;
   * the view shows the resulting channel state. An invalid batch fails the
   * request with nothing changed and the session not opened. A repeated load
   * with the same batch, or none, reports the recorded results and applies
   * nothing; a different batch fails `invalid_state`. */
  // ---- Tools, decision 0021.
  /** Every catalog entry and built-in with its availability. */
  "session/tools": { params: Record<string, never>; result: { tools: import("./tools.ts").ToolAvailability[] } };
  /** Revocable entries only (`invalid_state` otherwise; unknown name `not_found`).
   * Durable. Takes effect at the next inference and at any dispatch not yet made:
   * a pending approval for the tool is closed and its call skipped. */
  "tool/revoke": { params: { name: string }; result: { tool: import("./tools.ts").ToolAvailability } };
  "tool/restore": { params: { name: string }; result: { tool: import("./tools.ts").ToolAvailability } };
  /** Runtime entries only, from the catalog bound at open. In memory. */
  "tool/enable": { params: { name: string }; result: { tool: import("./tools.ts").ToolAvailability } };
  "tool/remove": { params: { name: string }; result: { tool: import("./tools.ts").ToolAvailability } };
  /** One call by invocation ID, from committed records. `not_found` if unknown. */
  "session/tool-invocation": { params: { invocationId: string }; result: { invocation: import("./tools.ts").ToolInvocation } };
  /** The calls of one turn, in request order. */
  "session/tool-invocations": { params: { turn: string }; result: { invocations: import("./tools.ts").ToolInvocation[] } };
  /** Only records committed at or before `revision`, after message `after`.
   * `not_found` for a revision the session has not reached. */
  "session/status": { params: Record<string, never>; result: StatusResult };
  /** Responds after `suspended` commits. Repeating it is harmless. Fails
   * `stopped` if the session is stopped before suspension commits. */
  "session/suspend": { params: Record<string, never>; result: StatusResult };
  /** Explicit; fails `incompatible` without consuming input or checkpoints. */
  "session/resume": { params: Record<string, never>; result: StatusResult };
  /** Immediate stop; running turns and checkpoints from an unfinished session
   * suspension are reported interrupted. A checkpoint committed by an individual
   * channel suspension is kept, and a still-suspending channel returns to
   * `open`. Stdin EOF does the same. */
  "session/stop": { params: Record<string, never>; result: StatusResult };
  /** Allowed when suspended, or when running with no running turn, nothing
   * pending, no checkpointed turn and no suspending channel; else `busy`. A
   * suspended channel with neither checkpoint nor backlog does not block. For
   * `transfer` the result names a readable transfer. */
  "session/export": { params: { to: ArchiveLocation }; result: { bytes: number; sha256: string; transferId?: string } };
  /** Validate fully, then publish atomically into a fresh home. Does not load,
   * start or resume the copy. `from.transfer` names a completed upload. */
  "session/import": { params: { from: { type: "path"; path: string } | { type: "transfer"; transferId: string }; sessionId?: string };
    result: { sessionId: string; lifecycle: "running" | "suspended"; revision: number } };
  // ---- Channel controls, decision 0014. Each is atomic, independent of the
  // session lifecycle, and fails with the stable codes in DurableErrorCode.
  /** Explicit create; starts nothing. Repeating the same request returns
   * `created: false`; a different name for an existing channel is
   * `already_exists`; a retired ID is `channel_retired`. */
  "channel/create": { params: { channel: string; displayName?: string; policy?: string }; result: { channel: ChannelStatusResult; created: boolean } };
  /** Display name only; `null` clears it. */
  "channel/edit": { params: { channel: string; displayName: string | null; policy?: string | null }; result: { channel: ChannelStatusResult } };
  /** Responds after the channel's `suspended` commits (checkpoint, completed
   * turn or interrupted turn). Repeating it is harmless. Fails `stopped` if the
   * session stops first. Meanwhile `channel/push` fails `channel_suspended`. */
  "channel/suspend": { params: { channel: string }; result: { channel: ChannelStatusResult } };
  /** Clears the channel suspension; work runs only when the session is
   * `running`. Fails `incompatible` without touching the checkpoint. */
  "channel/resume": { params: { channel: string }; result: { channel: ChannelStatusResult } };
  /** Retires the ID. `channel_busy` while a turn is active or checkpointed or
   * input is pending. */
  "channel/delete": { params: { channel: string }; result: { channel: ChannelStatusResult } };
  /** `taken` is the other side of the race with take and names the turn.
   * Messages and notices alike. */
  "channel/withdraw": { params: { channel: string; item: string };
    result: { outcome: "withdrawn" | "taken"; item: ItemStatus; repeated?: boolean } };
  /** Targets one turn. `interrupted: false` for a checkpointed or ended turn,
   * which is left as it is; `turn` is its current status. */
  "channel/interrupt": { params: { channel: string; turn: string; reason?: string };
    result: { interrupted: boolean; turn: TurnStatus } };
  // `reason` omitted: the stored reason is exactly "interrupted by request".
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
  /** Validate without opening a session or starting execution. */
  "config/validate": { params: { config: unknown }; result: { valid: true } };
  "approval/respond": { params: { requestId: string; decision: import("./config-permissions.ts").ApprovalAnswer }; result: { accepted: true } };
  /** `channelChanges` (decision 0020) follows the same rules as on load. */
  "session/create": OperatorMethods["session/create"];
  /** With durable acceptance the response is sent only after the inbox commit
   * and includes `item` (Received, or the original item's current state for a
   * retry). It never waits for or reports a reply. There is one delivery
   * behavior: `delivery` and `wake` are accepted for compatibility and ignored. */
  "channel/push": { params: PushParams; result: { accepted: true; item?: ItemStatus; duplicate?: boolean } };
  "channel/notify": { params: NotifyParams; result: { accepted: true; item: ItemStatus; duplicate: boolean } };
  "session/idle": { params: Record<string, never>; result: { idle: boolean } };
}
export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: unknown }
export type RpcResponse = { jsonrpc: "2.0"; id: number; result: unknown } |
  { jsonrpc: "2.0"; id: number | null; error: { code: number; message: string; data: { code: string } } };
export interface RpcNotification { jsonrpc: "2.0"; method: "channel/event"; params: ChannelEvent }
// ---- Requests from the harness to the host, decision 0021. IDs are numeric,
// per connection, and separate from the IDs of host requests: direction tells
// them apart. A response for a request that is no longer outstanding is ignored.
export type RpcCallbackRequest =
  | { jsonrpc: "2.0"; id: number; method: "functions/call"; params: import("./tools.ts").FunctionCall }
  | { jsonrpc: "2.0"; id: number; method: "results/read"; params: import("./tools.ts").ResultRead };
/** Ends the harness's wait for `invocationId`; the handler may stop. No reply. */
export interface RpcCallbackCancel { jsonrpc: "2.0"; method: "functions/cancel"; params: { invocationId: string; reason: string } }
export type RpcCallbackResponse = { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data: { code: string } } };
/** Transport carries envelopes; client owns correlation and request timeouts. */
export interface ClientTransport {
  send(request: RpcRequest): void;
  subscribe(listener: (message: RpcResponse | RpcNotification) => void): () => void;
  /** Decision 0013: required of every transport once `session/event` is listed
   * in capabilities. A transport must route `session/event` here and never to
   * `subscribe`. Relative order with channel events and responses is the wire
   * order. Optional only until the transports implement it. */
  subscribeSession?(listener: (notification: RpcSessionNotification) => void): () => void;
  /** Decision 0021. Requests and cancellations from the harness, in wire order
   * with events. Required of a transport once `functions` is advertised. */
  subscribeCallbacks?(listener: (message: RpcCallbackRequest | RpcCallbackCancel) => void): () => void;
  /** Answer a callback request by its ID. */
  respond?(response: RpcCallbackResponse): void;
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
  /** Close this connection's outstanding consumer approvals. */
  disconnect?(): void;
  request(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (notification: RpcNotification) => void): () => void;
  /** Lifecycle notifications, published after their commit. See ClientTransport. */
  subscribeSession?(listener: (notification: RpcSessionNotification) => void): () => void;
  /** Decision 0021: callback requests and cancellations for this connection's host. */
  subscribeCallbacks?(listener: (message: RpcCallbackRequest | RpcCallbackCancel) => void): () => void;
  /** The host's answer to a callback request. Unknown or closed IDs are ignored. */
  respond?(response: RpcCallbackResponse): void;
}
