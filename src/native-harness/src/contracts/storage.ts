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
   * A mismatch no longer fails open: the session stays readable and exportable.
   * It is recorded on each turn at begin and compared by exact equality when a
   * suspended checkpoint is resumed. No automatic config migration. */
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
  /** The key supplied at this open; used for turns begun and resumed by this owner. */
  compatibilityKey: string;
}

/** A channel remains available for new turns after failure or interruption. */
export interface StoredChannel {
  channelId: string;
  /** Derived from the channel's timeline entries: who has spoken, not access rights. */
  participantIds: string[];
}

/** Observed caller identity. Participant roles/policies are outside this contract. */
export interface StoredParticipant { participantId: string }

/** New work offered to the durable inbox. `senderId` is a participant ID for a
 * message and `channel:<sourceChannelId>` for a notice. */
export interface AcceptItem {
  /** Stable caller ID used for deduplication. Storage allocates one if omitted;
   * allocated IDs never collide with earlier ones, including after reopen/import. */
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
  /** Canonical digest of kind, channel, sender, source and text. */
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
   * 4. Commit the pending item, and for a message its channel/participant.
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
   * nothing. Requires `running` lifecycle (`not_running` while suspending, so
   * suspension never forces an extra inference). */
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
   * milestone advanced; none advancing commits nothing. Never called for an
   * outbound request alone, a rejected call, or another channel's inference. */
  confirmReceipts(turnId: number, milestone: "delivered" | "seen"): StorageResult<StoredItem[]>;

  /** End a running turn.
   * - completed: requires a recorded final tool-free assistant response and no
   *   unanswered calls. While the lifecycle is `running`, the pending-inbox check
   *   is part of this transaction: if the channel has pending items the turn
   *   stays running and `{ finished: false }` is returned; the caller takes them
   *   and continues. While `suspending`, the turn completes and pending items
   *   stay pending for a later turn.
   * - failed / interrupted: unconditional. Recorded entries, taken items and
   *   receipts are kept; unanswered calls become `uncertainCallIds`; pending
   *   items stay pending; the channel can begin a new turn.
   * Terminal states cannot be overwritten or applied twice (`invalid_state`). */
  finishTurn(
    turnId: number,
    outcome: { status: "completed" } | { status: "failed" | "interrupted"; reason: string },
  ): StorageResult<{ finished: true; turn: StoredTurn } | { finished: false; pending: number }>;

  /** running -> suspended with a checkpoint at the inference boundary. Requires
   * `suspending` lifecycle and no unanswered calls. */
  checkpointTurn(turnId: number): StorageResult<StoredTurn>;

  /** running -> suspending. Already suspending or suspended returns that state
   * unchanged. From this commit, new messages, beginTurn and takePending are refused. */
  beginSuspend(): StorageResult<StoredSession>;

  /** suspending -> suspended. `invalid_state` while any turn is still running.
   * Already suspended returns unchanged. Pending items and checkpoints persist. */
  completeSuspend(): StorageResult<StoredSession>;

  /** suspended -> running; every suspended turn returns to running in the same
   * transaction and is returned for continuation. `incompatible`, changing
   * nothing, if any checkpointed turn's compatibilityKey differs from this
   * owner's. Already running returns no turns; `suspending` is `invalid_state`. */
  resume(): StorageResult<{ session: StoredSession; turns: StoredTurn[] }>;

  /** Full neutral read for load/inspection/context. No prompt rendering or SQL
   * leaks through this interface. Reading does not start or resume any work. */
  snapshot(): StorageResult<StorageSnapshot>;

  /** One consistent logical copy. Allowed when no turn is running and either the
   * lifecycle is `suspended` or nothing is pending; otherwise `busy`. Leaves the
   * session unchanged. */
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
   * Any failure leaves no partial session. The result is not opened or owned. */
  importArchive(archive: SessionArchive, options?: { sessionId?: string }): StorageResult<StoredSession>;
}
