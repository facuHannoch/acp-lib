import type { ItemKind, ItemMilestone } from "./agent.ts";
import type { ContextEntry } from "./context.ts";
import type { Message } from "./loop.ts";

/** Storage contract revision 2 (decision 0013). Type-only until adapters land.
 * One owner process, one session per location. Every method is synchronous and
 * is one atomic transaction, so the owner's calls are totally ordered: any two
 * operations (for example an acceptance and a finish) commit in one definite
 * order and each observes the other's full effect or none of it. No transaction
 * spans inference or tool execution. */

/** Expected failures never require callers to inspect SQLite or exception text. */
export type StorageErrorCode =
  | "already_exists" | "not_found" | "owner_conflict" | "incompatible"
  | "invalid_input" | "invalid_state" | "closed"
  /** The item ID was accepted earlier with a different payload signature. */
  | "item_conflict"
  /** The session lifecycle does not admit this work (suspending/suspended). */
  | "not_running"
  /** Export refused: active or pending work exists and the session is not suspended. */
  | "busy"
  | "invalid_archive"
  | "serialization_error" | "storage_failure";

/** A failed mutation leaves no partial domain changes. Do not retry blindly. */
export interface StorageError { code: StorageErrorCode; message: string }

/** A success returns only after commit and names the storage revision that
 * includes it (the current revision for reads and no-op calls). A failure
 * exposes no success value and commits nothing. */
export type StorageResult<T> = { ok: true; value: T; revision: number } | { ok: false; error: StorageError };

/** Supplied again on every open. Contains no secrets or executable implementations. */
export interface StorageIdentity {
  sessionId: string;
  /** Caller-defined identity of compatible prompt, model and tool configuration.
   * The key given to `create` is stored once. A different key on `open` does not
   * fail and is never written by open: the session stays readable and exportable.
   * This owner's key is recorded on each turn it begins, and compared by exact
   * equality with every checkpointed turn's key on resume. Items that were never
   * taken use the key of the owner that later begins their turn. */
  compatibilityKey: string;
}

/** No implicit create-on-open or overwrite. Location is configured on the adapter. */
export interface StorageOpenOptions {
  mode: "create" | "open";
  identity: StorageIdentity;
}

/** `suspended` is committed only by completeSuspend; it is the sole state that
 * preserves checkpoints across reopen. */
export type SessionLifecycle = "running" | "suspending" | "suspended";

/** Timestamps are UTC strings assigned by storage; never use them as ordering keys. */
export interface StoredSession {
  sessionId: string;
  /** Storage contract/data format revision, distinct from RPC and archive versions. */
  formatVersion: 2;
  createdAt: string;
  lifecycle: SessionLifecycle;
  /** The key supplied at create. Immutable; open never rewrites it. */
  compatibilityKey: string;
}

/** A channel remains available for new turns after failure or interruption. */
export interface StoredChannel {
  channelId: string;
  /** Derived from the channel's timeline entries: senders that have a timeline
   * entry there, not access rights. A sender whose message is still pending is
   * not listed until take. */
  participantIds: string[];
}

/** Observed caller identity. Participant roles/policies are outside this contract. */
export interface StoredParticipant { participantId: string }

/** New work offered to the durable inbox. `senderId` is a participant ID for a
 * message and `channel:<sourceChannelId>` for a notice. */
export interface AcceptItem {
  /** Stable caller ID used for deduplication. If omitted, storage assigns
   * `auto:<decimal nextItemNumber>` and increments that counter (first value 1).
   * Accepting a caller ID of the exact form `auto:<n>` with n >= the counter sets
   * the counter to n + 1. The counter is durable and restored by import, so an
   * allocated ID is never issued twice. */
  itemId?: string;
  kind: ItemKind;
  channelId: string;
  senderId: string;
  sourceChannelId?: string;
  /** Original payload, kept unrendered for the life of the item. */
  text: string;
}

/** An accepted input. While `milestone` is `received` it is pending: in the
 * inbox, outside the timeline and outside every model context. From take onward
 * `turnId`/`entrySeq` are set and never change; the item is never pending again. */
export interface StoredItem extends Required<Pick<AcceptItem, "itemId">>, Omit<AcceptItem, "itemId"> {
  /** Lowercase hex SHA-256 of the UTF-8 bytes of
   * `JSON.stringify([kind, channelId, senderId, sourceChannelId ?? null, text])`
   * (a JSON array, no extra whitespace). Identical in every adapter and archive. */
  signature: string;
  /** Global sequence position of acceptance; acceptance order within a channel. */
  acceptedSeq: number;
  acceptedAt: string;
  /** Last confirmed milestone. Failure or interruption never lowers it. */
  milestone: ItemMilestone;
  turnId?: number;
  entrySeq?: number;
}

/** A timeline entry. `seq` comes from the session-wide committed sequence and is
 * the entry's stable ID (assistant message ID `String(seq)`); values increase
 * but need not be contiguous. `itemId` is set on entries created by a take. */
export interface TimelineEntry extends ContextEntry { itemId?: string }

/** Enough to continue at the next step without repeating recorded work. Only
 * references to committed records; no functions, credentials or handles. */
export interface TurnCheckpoint {
  /** The only resumable boundary: every requested call has a recorded result. */
  nextStep: "inference";
  /** Last timeline seq of the turn when it was checkpointed. */
  afterSeq: number;
}

/** A turn exists only from its first take; there is no queued turn. Failed and
 * interrupted are terminal for the turn and leave the channel usable.
 * `uncertainCallIds` lists recorded calls with no recorded result: their
 * external effect is unknown and they are never executed again by the harness. */
export type StoredTurnState =
  | { status: "running" }
  | { status: "suspended"; checkpoint: TurnCheckpoint }
  | { status: "completed" }
  | { status: "failed"; reason: string; uncertainCallIds: string[] }
  | { status: "interrupted"; reason: string; uncertainCallIds: string[] };

export interface StoredTurn {
  /** Positive safe integer, never reused, increasing in begin order. */
  turnId: number;
  channelId: string;
  /** Every item this turn has taken, in take order. Several IDs may share a turn. */
  itemIds: string[];
  startedSeq: number;
  startedAt: string;
  /** Configuration identity under which the turn began. */
  compatibilityKey: string;
  state: StoredTurnState;
}

/** Items taken by one transaction with the turn link and timeline entries they produced. */
export interface TurnTake { turn: StoredTurn; items: StoredItem[]; entries: TimelineEntry[] }

/** One consistent read at `revision`; records never alias storage or caller objects. */
export interface StorageSnapshot {
  /** Number identifying this committed state. Increases with every commit. */
  revision: number;
  session: StoredSession;
  channels: StoredChannel[];
  participants: StoredParticipant[];
  /** Ordered by turn ID. */
  turns: StoredTurn[];
  /** Pending and taken items, ordered by acceptedSeq. Retained for deduplication. */
  items: StoredItem[];
  /** All entries in increasing seq order, suitable for the context builder. */
  timeline: TimelineEntry[];
}

/** Logical, adapter-independent session copy. JSON-serializable. Versioned
 * independently of `formatVersion`. Byte encoding belongs to the archive module. */
export interface SessionArchive {
  format: "harness-session";
  archiveVersion: 1;
  exportedAt: string;
  snapshot: StorageSnapshot;
  /** ID allocation state so the copy never reissues a turn ID, seq or item ID. */
  allocation: { nextTurnId: number; nextSeq: number; nextItemNumber: number };
}

/** Only the adapter's owner closes this handle; borrowers must not close it. */
export interface SessionStorage {
  /** Durable acceptance (the Received milestone). In order:
   * 1. A known itemId with the same signature returns the original item with
   *    `duplicate: true` and commits nothing, in every lifecycle state and after
   *    reopen. A different signature is `item_conflict`.
   * 2. Empty routing/content is `invalid_input`. A notice to a channel that has
   *    never accepted a message is `not_found`.
   * 3. Lifecycle admission: messages need `running`; notices are also admitted
   *    while `suspending`. Otherwise `not_running`.
   * 4. Commit the pending item. A message also creates its StoredChannel and
   *    StoredParticipant if new; `participantIds` is unaffected until take.
   * Nothing is added to the timeline and no turn is created or changed. */
  acceptItem(input: AcceptItem): StorageResult<{ item: StoredItem; duplicate: boolean }>;

  /** Start the channel's next turn by taking ALL its pending items, in
   * acceptance order, in one transaction: create the running turn, move each
   * item received -> taken, append its timeline entry and link both to the turn.
   * A message entry renders as `Participant: <JSON id>\n\n<text>`; a notice as
   * its text. Returns null, committing nothing, when the channel has a running
   * or suspended turn or has nothing pending. Requires `running` lifecycle. */
  beginTurn(channelId: string): StorageResult<TurnTake | null>;

  /** Steering: take all items pending on a running turn's channel, exactly as
   * beginTurn does, at the turn's inference boundary. An empty take commits
   * nothing. A turn that is not running is `invalid_state` and takes nothing, so
   * a late caller cannot link items to an ended or checkpointed turn. Requires
   * `running` lifecycle: refused with `not_running` for the whole `suspending`
   * state, so suspension never forces an extra inference. A resumed turn calls
   * this before its first inference. */
  takePending(turnId: number): StorageResult<TurnTake>;

  /** Append only to a running turn. Storage assigns seq/time/channel/turn/from.
   * Assistant messages are from agent; tool results are from tool. Calls are
   * recorded before execution. A new assistant response requires all prior calls
   * in the turn to have results. Tool results must match an unanswered call in
   * that turn; duplicate call IDs/results are invalid. Each operation is atomic.
   * A turn that is no longer running rejects with `invalid_state`: this is the
   * fence that stops late model/tool output from advancing stopped work.
   * Reject non-JSON data, including unsupported opaque provider state, without
   * silently discarding it. Preserve supported provider state unchanged. */
  appendMessage(
    turnId: number,
    message: Extract<Message, { role: "assistant" | "tool" }>,
  ): StorageResult<TimelineEntry>;

  /** Record provider evidence for every item the running turn has taken so far
   * (no take can occur during the turn's own inference, so these are exactly the
   * items in that request). `seen` implies `delivered`. Returns the items whose
   * milestone advanced; none advancing commits nothing. A turn that is not
   * running is `invalid_state` and commits nothing, so a model result arriving
   * after interruption or failure cannot advance a receipt. Never called for an
   * outbound request alone, a rejected call, or another channel's inference. */
  confirmReceipts(turnId: number, milestone: "delivered" | "seen"): StorageResult<StoredItem[]>;

  /** End a running turn.
   * - completed: requires a recorded final tool-free assistant response and no
   *   unanswered calls. The pending-inbox check is part of this transaction in
   *   both `running` and `suspending`: if the channel has pending items the turn
   *   stays running and `{ finished: false }` is returned. While `running` the
   *   caller then takes them and infers again. While `suspending` the caller
   *   must checkpoint instead; the items stay pending for the resumed turn.
   * - failed / interrupted: unconditional. Recorded entries, taken items and
   *   receipts are kept; unanswered calls become `uncertainCallIds`; pending
   *   items stay pending; the channel can begin a new turn.
   * Terminal states cannot be overwritten or applied twice (`invalid_state`). */
  finishTurn(
    turnId: number,
    outcome: { status: "completed" } | { status: "failed" | "interrupted"; reason: string },
  ): StorageResult<{ finished: true; turn: StoredTurn } | { finished: false; pending: number }>;

  /** running -> suspended with a checkpoint at the inference boundary, for a
   * turn that still needs an inference. Requires `suspending` lifecycle and no
   * unanswered calls. `invalid_state`, changing nothing, when the turn's last
   * entry is a tool-free assistant response and its channel has nothing
   * pending: that turn is naturally finished and must be completed instead.
   * Pending items are not taken; they wait for the resumed turn. */
  checkpointTurn(turnId: number): StorageResult<StoredTurn>;

  /** running -> suspending. Already suspending or suspended returns that state
   * unchanged. From this commit, new messages, beginTurn and takePending are refused. */
  beginSuspend(): StorageResult<StoredSession>;

  /** suspending -> suspended. `invalid_state` while any turn is still running,
   * and when the lifecycle is `running` (never suspending, or stopped by
   * interruptActive). Already suspended returns unchanged. Pending items and
   * checkpoints persist. */
  completeSuspend(): StorageResult<StoredSession>;

  /** suspended -> running; every suspended turn returns to running in the same
   * transaction and is returned for continuation. `incompatible`, writing
   * nothing (lifecycle, checkpoints and pending items all unchanged), if any
   * checkpointed turn's compatibilityKey differs from the key passed to this
   * open. Already running returns no turns; `suspending` is `invalid_state`. */
  resume(): StorageResult<{ session: StoredSession; turns: StoredTurn[] }>;

  /** Stop, in one transaction, by lifecycle:
   * - `running`: every running turn becomes interrupted.
   * - `suspending`: every running AND every checkpointed turn becomes
   *   interrupted and the lifecycle returns to `running`, so this attempt can
   *   no longer commit `suspended`.
   * - `suspended`: nothing changes; clean checkpoints are kept.
   * Unanswered calls become `uncertainCallIds`. Pending items stay pending.
   * Returns the turns interrupted by this call. */
  interruptActive(reason: string): StorageResult<StoredTurn[]>;

  /** Full neutral read for load/inspection/context. No prompt rendering or SQL
   * leaks through this interface. Reading does not start or resume any work. */
  snapshot(): StorageResult<StorageSnapshot>;

  /** One consistent logical copy. Allowed only when the lifecycle is
   * `suspended`, or it is `running` with no running turn and nothing pending.
   * `suspending` is always `busy`, even when every turn is already checkpointed
   * or completed, because that state is not yet a clean suspension. Any other
   * case is `busy`. Leaves the session unchanged. */
  exportArchive(): StorageResult<SessionArchive>;

  /** Release ownership/resources, never erase history. Idempotent after success.
   * Caller must first stop using the handle from live execution. This is NOT
   * suspend or stop: turns still running are interrupted by the next open.
   * Failure must not advertise released ownership. Other calls after successful
   * close return closed. */
  close(): StorageResult<void>;
}

/** Adapter configured with a location (for example a SQLite path) by assembly.
 * Methods are synchronous. Returned values and later reads are defensive copies.
 * Commit notifications/output are wired by composition after success, never
 * from inside a transaction. No durable event replay is promised. */
export interface SessionStorageAdapter {
  /** Acquire exclusive ownership, then check format and session ID, before any
   * write. A second owner (`owner_conflict`), unreadable or unsupported format
   * and a different session ID (`incompatible`) leave the data untouched.
   * Recovery on reopen is one transaction, and executes nothing:
   * - lifecycle `suspended`: no change. Pending items and checkpoints are kept
   *   for explicit resume.
   * - lifecycle `running` or `suspending` (the prior owner exited without clean
   *   suspension): every running or suspended turn becomes interrupted with its
   *   unanswered calls as `uncertainCallIds`; lifecycle becomes `running`.
   *   Taken items stay with their turn; pending items stay pending. */
  open(options: StorageOpenOptions): StorageResult<SessionStorage>;

  /** Validate the whole archive, then publish it atomically at this adapter's
   * location, which must not already hold a session (`already_exists`). IDs
   * inside the session are preserved; `sessionId` may replace the session's own.
   * An archive whose lifecycle is `suspending`, or that holds a running turn, is
   * `invalid_archive`: open would interrupt its checkpoints as an unclean exit.
   * Any failure leaves no partial session. The result is not opened or owned. */
  importArchive(archive: SessionArchive, options?: { sessionId?: string }): StorageResult<StoredSession>;
}
