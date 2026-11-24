import type { InspectionStorageReads } from "./inspection.ts";
import type { IntakeLimit } from "./input-limits.ts";
import type { OperatorStorageReads } from "./operator-controls.ts";
import type { ModelCallStore } from "./model-execution.ts";
import type { ItemKind, ItemMilestone } from "./agent.ts";
import type { ContextEntry, InferenceStorageReads } from "./context.ts";
import type { Message } from "./loop.ts";

/** Storage contract revision 4 (decisions 0013, 0014, 0016).
 * One owner process, one session per location. Every method is synchronous and
 * is one atomic transaction, so the owner's calls are totally ordered: any two
 * operations (for example an acceptance and a finish) commit in one definite
 * order and each observes the other's full effect or none of it. No transaction
 * spans inference or tool execution. */

/** Expected failures never require callers to inspect SQLite or exception text. */
export type StorageErrorCode =
  | "already_exists" | "not_found" | "owner_conflict" | "incompatible"
  | "invalid_input" | "invalid_config" | "invalid_state" | "invalid_policy" | "closed"
  /** The item ID was accepted earlier with a different payload signature. */
  | "item_conflict"
  /** The session lifecycle does not admit this work (suspending/suspended). */
  | "not_running"
  /** The channel's own suspension (suspending/suspended) does not admit or run this work. */
  | "channel_suspended"
  /** The channel ID is retired (deleted); it is reserved and never reused. */
  | "channel_retired"
  /** Deletion refused: the channel has an active or checkpointed turn, or pending input. */
  | "channel_busy"
  /** Export refused: active or pending work exists and the session is not suspended. */
  | "busy"
  | "invalid_archive"
  | "serialization_error" | "storage_failure" | "transfer_limit" | "invalid_cursor" | "unsupported_image" | "attachment_unavailable";

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
  /** Opt-in scripted identity check. Create persists identity.compatibilityKey
   * as scripted-jsonl-v1:<digest>:<systemHash>, with both hashes lowercase
   * 64-character hexadecimal SHA-256. The digest segment must equal this value.
   * Under ownership, open matches that segment of the stored key exactly.
   * Untagged, malformed, or mismatched keys return incompatible without writes,
   * before format upgrade, recovery, attempt repair, or any reservation.
   * Existing checkpoint comparison uses the entire key, including systemHash.
   * Changing only the system preserves open but blocks checkpoint resume.
   * Callers that omit this option retain the existing behavior. */
  requiredScriptDigest?: string;
  /** Validated policies for this owner; legacy callers use the legacy policy. */
  config?: import("./config-permissions.ts").ManagedConfig;
}

/** `suspended` is committed only by completeSuspend; it is the sole state that
 * preserves checkpoints across reopen. */
export type SessionLifecycle = "running" | "suspending" | "suspended";

/** Timestamps are UTC strings assigned by storage; never use them as ordering keys. */
export interface StoredSession {
  sessionId: string;
  /** Storage contract/data format revision, distinct from RPC and archive versions.
   * Revision 5 stores model calls and script reservations. Formats 2–4 upgrade on open. */
  formatVersion: 6 | 7 | 8 | 9 | 10;
  createdAt: string;
  lifecycle: SessionLifecycle;
  /** The key supplied at create. Immutable; open never rewrites it. */
  compatibilityKey: string;
}

/** The channel's own lifecycle, independent of the session's and of its turn
 * status (decision 0014). `open`: admits input; it may be idle or have a turn.
 * `suspending`: closed to input and to taking pending items while its running
 * turn finishes the current iteration; it always has a running turn.
 * `suspended`: committed and durable; admits no input, takes no pending items
 * and starts nothing, and may hold a checkpointed turn. `retired`: deleted; the
 * ID is reserved forever and the timeline is kept. `retired` is final. */
export type ChannelLifecycle = "open" | "suspending" | "suspended" | "retired";

/** A channel remains available for new turns after failure or interruption. */
export interface StoredChannel {
  channelId: string;
  policy?: string;
  /** Optional label; never an identity. 1..200 characters after trimming. */
  displayName?: string;
  lifecycle: ChannelLifecycle;
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
  /** Trusted participant override; null and omission are equivalent. */
  explicitPolicy?: string | null;
  /** Internal source turn of a notice; never supplied by model arguments. */
  sourceTurnId?: number;
  /** External notice attribution and submitted policy set only. */
  externalSource?: string;
  inheritedPolicyNames?: readonly string[];
  /** Original payload, kept unrendered for the life of the item. */
  text: string;
  /** Ordered mixed input; absent for legacy text-only identity. */
  parts?: readonly import("./attachments.ts").InputPart[];
}

/** An accepted input. While `milestone` is `received` it is pending: in the
 * inbox, outside the timeline and outside every model context. From take onward
 * `turnId`/`entrySeq` are set and never change; the item is never pending again.
 * `withdrawn` is the other terminal state of a pending item: it was never taken,
 * is not pending, has no `turnId`/`entrySeq`, never enters the timeline and is
 * retained for deduplication, so a retry cannot make it pending again. */
export interface StoredItem extends Required<Pick<AcceptItem, "itemId">>, Omit<AcceptItem, "itemId"> {
  policy?: import("./config-permissions.ts").ItemPolicy;
  /** Lowercase SHA-256 of the UTF-8 identity array in decision 0025.
   * External notices use source and the sorted inherited set. Existing
   * participant and internal notice formulas retain their explicit override. */
  signature: string;
  /** Global sequence position of acceptance; acceptance order within a channel. */
  acceptedSeq: number;
  acceptedAt: string;
  /** Last confirmed milestone. Failure or interruption never lowers it. */
  milestone: ItemMilestone;
  /** Set only when `milestone` is `withdrawn`. */
  withdrawnAt?: string;
  turnId?: number;
  entrySeq?: number;
}

/** A timeline entry. `seq` comes from the session-wide committed sequence and is
 * the entry's stable ID (assistant message ID `String(seq)`); values increase
 * but need not be contiguous. `itemId` is set on entries created by a take. */
export interface TimelineEntry extends ContextEntry { itemId?: string; /** Reserved model message ID when produced by the call runner. */ messageId?: string }

/** Enough to continue at the next step without repeating recorded work. Only
 * references to committed records; no functions, credentials or handles. */
export interface TurnCheckpoint {
  /** The only resumable boundary: every requested call has a recorded result. */
  nextStep: "inference";
  /** Last timeline seq of the turn when it was checkpointed. */
  afterSeq: number;
  /** Canonical definitions of policies contributed by inputs taken by this turn. */
  policyFingerprint?: string;
}

/** A turn exists only from its first take; there is no queued turn. Failed and
 * interrupted are terminal for the turn and leave the channel usable.
 * `uncertainCallIds` lists recorded calls with no recorded result: their
 * external effect is unknown and they are never executed again by the harness. */
export type StoredTurnState =
  | { status: "running"; dispatchedCallIds?: string[] }
  | { status: "suspended"; checkpoint: TurnCheckpoint; dispatchedCallIds?: string[] }
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
  /** Pending, taken and withdrawn items, ordered by acceptedSeq. Retained for
   * deduplication. A withdrawn item has no turn link and no timeline entry; it
   * survives export, import and reopen so a retry cannot revive it. */
  items: StoredItem[];
  /** All entries in increasing seq order, suitable for the context builder. */
  timeline: TimelineEntry[];
  /** Durable call records and each channel's next zero-based scripted step. */
  modelCalls: import("./model-execution.ts").ModelCallSummary[];
  scriptPositions: Record<string, number>;
  /** Decision 0021: names of revocable tools whose grant is revoked, sorted.
   * Absent when none ever was. Carried by export and import. */
  revokedTools?: string[];
  webDispatches?: import("./web.ts").StoredWebDispatch[];
}

/** Logical, adapter-independent session copy. JSON-serializable. Versioned
 * independently of `formatVersion`. Version 4 adds model call records and script reservations.
 * Version 5 adds external notices. */
export interface SessionArchive {
  format: "harness-session";
  archiveVersion: 5 | 6 | 7 | 8;
  /** Complete retained managed bytes, only in logical archive 8. */
  attachmentState?: { baseFormat: 6 | 7 | 8; files: Array<{ metadata: import("./attachments.ts").AttachmentMetadata; readyAt: string; bytes: Uint8Array }> };
  reminderState?: import("./reminders.ts").ReminderArchiveState;
  exportedAt: string;
  snapshot: StorageSnapshot;
  /** ID allocation state so the copy never reissues a turn ID, seq or item ID. */
  allocation: { nextTurnId: number; nextSeq: number; nextItemNumber: number };
}

/** The archive written by the persistence revision. Import-only: it is read as
 * every channel `open` without a name, no withdrawn items and no retired IDs.
 * Nothing in this revision exports it. */
export interface SessionArchiveV1 {
  format: "harness-session";
  archiveVersion: 1;
  exportedAt: string;
  snapshot: Omit<StorageSnapshot, "session" | "channels" | "modelCalls" | "scriptPositions"> & {
    session: Omit<StoredSession, "formatVersion"> & { formatVersion: 2 };
    channels: Omit<StoredChannel, "displayName" | "lifecycle">[];
  };
  allocation: SessionArchive["allocation"];
}

/** Import-only logical format from the channel-controls revision. */
export interface SessionArchiveV2 {
  format: "harness-session"; archiveVersion: 2; exportedAt: string;
  snapshot: Omit<StorageSnapshot, "session" | "modelCalls" | "scriptPositions"> & { session: Omit<StoredSession, "formatVersion"> & { formatVersion: 3 } };
  allocation: SessionArchive["allocation"];
}

/** Import-only logical format from configuration and permissions. */
export interface SessionArchiveV3 {
  format: "harness-session"; archiveVersion: 3; exportedAt: string;
  snapshot: Omit<StorageSnapshot, "session" | "modelCalls" | "scriptPositions"> & { session: Omit<StoredSession, "formatVersion"> & { formatVersion: 4 } };
  allocation: SessionArchive["allocation"];
}

/** Import-only model execution archive, before external notices. */
export interface SessionArchiveV4 extends Omit<SessionArchive, "archiveVersion" | "snapshot"> {
  archiveVersion: 4;
  snapshot: Omit<StorageSnapshot, "session"> & { session: Omit<StoredSession, "formatVersion"> & { formatVersion: 5 } };
}

/** Result of `withdrawItem`. The two outcomes are the two sides of the race with
 * take; whichever transaction commits first decides, and the decision is final.
 * `withdrawn` also answers a repeat of an earlier successful withdrawal. */
export type WithdrawOutcome =
  | { outcome: "withdrawn"; item: StoredItem; repeated: boolean }
  | { outcome: "taken"; item: StoredItem; turnId: number };

/** Result of `interruptTurn`. `interrupted: false` changes nothing and returns
 * the turn as it is now: it was already ended, or is checkpointed. */
export type InterruptOutcome =
  | { interrupted: true; turn: StoredTurn }
  | { interrupted: false; turn: StoredTurn };

/** Only the adapter's owner closes this handle; borrowers must not close it. */
export interface TimelineRetrievalReads {
  searchTimeline(input: import("./timeline-retrieval.ts").TimelineSearch, maxResponseBytes?: number): StorageResult<import("./timeline-retrieval.ts").TimelineSearchResult>;
  readMessage(input: import("./timeline-retrieval.ts").TimelineWindow, maxResponseBytes?: number): StorageResult<import("./timeline-retrieval.ts").TimelineWindowResult>;
}

export interface ReminderStorage {
  scheduleAgentReminder(turnId: number, invocationId: string, schedule: import("./reminders.ts").AgentReminderSchedule | import("./reminders.ts").RoutineSchedule, text: string,
    policyNames: readonly string[], expiresAfter: number | null | undefined, now: number, delivery?: import("./reminders.ts").RoutineDeliveryOptions): StorageResult<{ reminder: import("./reminders.ts").Reminder; created: boolean }>;
  cancelAgentReminder(turnId: number, id: string): StorageResult<{ id: string; alreadyQueued: boolean; changed: boolean }>;
  changeReminder(change: import("./reminders.ts").ReminderChange, now: number): StorageResult<import("./reminders.ts").ReminderChangeResult>;
  readReminder(id: string): StorageResult<import("./reminders.ts").Reminder | undefined>;
  listReminders(input: import("./reminders.ts").ReminderListParams): StorageResult<import("./reminders.ts").ReminderList>;
  reminderWake(): StorageResult<import("./reminders.ts").ReminderWake>;
  fireDueReminders(now: number): StorageResult<Array<{ channel: string; event: import("./reminders.ts").ReminderChannelEvent }>>;
}

export interface SessionStorage extends ModelCallStore, ReminderStorage, TimelineRetrievalReads, OperatorStorageReads, InferenceStorageReads, InspectionStorageReads {
  /** Owner-only publication fence. The managed-byte owner calls this only
   * after it has verified and durably published the immutable bytes. */
  registerReadyAttachment(metadata: import("./attachments.ts").AttachmentMetadata): StorageResult<void>;
  /** Owner-scoped metadata and timeline visibility; bytes are read separately. */
  readManagedAttachment(id: string): StorageResult<{ metadata: import("./attachments.ts").AttachmentMetadata; timelineVisible: boolean } | undefined>;
  /** IDs with committed ready metadata, for owner-only crash recovery. */
  managedAttachmentIds(): StorageResult<string[]>;
  /** Owner-only cleanup fence; accepted references prevent reclamation. */
  unreferencedAttachments(readyBefore: string): StorageResult<import("./attachments.ts").AttachmentMetadata[]>;
  reclaimAttachment(id: string, readyBefore: string): StorageResult<boolean>;
  readSession(): StorageResult<StoredSession>;
  readExecution(): StorageResult<Pick<StorageSnapshot, "revision" | "session" | "channels" | "turns" | "items">>;
  readReadyChannels(intake?: IntakeLimit): StorageResult<{ lifecycle: SessionLifecycle; channels: string[] }>;
  readRevokedTools(): StorageResult<string[]>;
  /** Validated config supplied to this open, copied at bind time; undefined for
   * legacy allow-only opens. Returns a defensive copy. It is independent of
   * saved/imported config and is not retargeted by saveConfig. Failure is not
   * equivalent to absence and must fail session assembly. */
  ownerConfig(): StorageResult<import("./config-permissions.ts").ManagedConfig | undefined>;
  /** Commit that a running turn's own unanswered, not-yet-marked call is being
   * dispatched. Invalid or duplicate marks write nothing; failure cannot invoke
   * the tool or emit started. After success its effect is uncertain until its
   * result commits. This evidence is never an approval grant. */
  markToolDispatched(turnId: number, callId: string, evidence?: import("./web.ts").WebDispatchEvidence): StorageResult<void>;
  /** False when stored policy references cannot be resolved by this owner. */
  unattendedGuard(): StorageResult<number | undefined>;
  executionCompatible(): StorageResult<boolean>;
  /** Imported configuration, or undefined for sessions not imported from a file. */
  importedConfig(): StorageResult<import("./session-file.ts").PortableSessionConfig | undefined>;
  /** Persist the validated configuration used by this owner. */
  saveConfig(config: import("./config-permissions.ts").ManagedConfig): StorageResult<void>;
  /** Durable acceptance (the Received milestone). In order:
   * 1. A known itemId with the same signature returns the original item with
   *    `duplicate: true` and commits nothing, in every lifecycle state, for a
   *    withdrawn item and after reopen. A different signature is `item_conflict`.
   * 2. Empty routing/content is `invalid_input`. A notice to a channel that has
   *    no record (never created or messaged) is `not_found`.
   * 3. A retired channel ID is `channel_retired`, for messages and notices.
   * 4. Session admission: messages need `running`; notices are also admitted
   *    while `suspending`. Otherwise `not_running`.
   * 5. Channel admission: a `suspending` or `suspended` channel refuses messages
   *    and notices alike with `channel_suspended`. (Step 4 is checked first.)
   * 6. Commit the pending item. A message to an ID with no record also creates
   *    its StoredChannel (open, unnamed) and StoredParticipant; `participantIds`
   *    is unaffected until take.
   * Nothing is added to the timeline and no turn is created or changed. */
  /** External notice retries compare durable identity before admission or
   * policy validation for new work, through a path that writes nothing. */
  acceptItem(input: AcceptItem, maxInputBytes?: number, options?: { imageInput?: boolean }): StorageResult<{ item: StoredItem; duplicate: boolean }>;

  /** Start the channel's next turn by taking ALL its pending items, in
   * acceptance order, in one transaction: create the running turn, move each
   * item received -> taken, append its timeline entry and link both to the turn.
   * A message entry renders as `Participant: <JSON id>\n\n<text>`; a notice as
   * its text. Returns null, committing nothing, when the channel has a running
   * or suspended turn or has nothing pending. Requires `running` session
   * lifecycle (`not_running`) and an `open` channel (`channel_suspended`; an
   * unknown or retired channel is `not_found`/`channel_retired`). */
  beginTurn(channelId: string, intake?: IntakeLimit): StorageResult<TurnTake | null>;

  /** Steering: take all items pending on a running turn's channel, exactly as
   * beginTurn does, at the turn's inference boundary. An empty take commits
   * nothing. A turn that is not running is `invalid_state` and takes nothing, so
   * a late caller cannot link items to an ended or checkpointed turn. Requires
   * `running` lifecycle: refused with `not_running` for the whole `suspending`
   * state, so suspension never forces an extra inference. The same holds for the
   * turn's channel while `suspending`: `channel_suspended`, taking nothing. A
   * resumed turn calls this before its first inference. */
  takePending(turnId: number, intake?: IntakeLimit): StorageResult<TurnTake>;

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
   *   must checkpoint instead; the items stay pending for the resumed turn. The
   *   same applies while the turn's channel is `suspending`.
   * - failed / interrupted: unconditional. Recorded entries, taken items and
   *   receipts are kept; unanswered calls become `uncertainCallIds`; pending
   *   items stay pending; the channel can begin a new turn.
   * Terminal states cannot be overwritten or applied twice (`invalid_state`).
   * Whenever this transaction ends the running turn of a `suspending` channel,
   * the channel becomes `suspended` in the same transaction (no checkpoint). */
  finishTurn(
    turnId: number,
    outcome: { status: "completed" } | { status: "failed" | "interrupted"; reason: string },
  ): StorageResult<{ finished: true; turn: StoredTurn } | { finished: false; pending: number }>;

  /** running -> suspended with a checkpoint at the inference boundary, for a
   * turn that still needs an inference. Requires the session lifecycle or the
   * turn's channel to be `suspending`, and no unanswered calls. A `suspending`
   * channel becomes `suspended` in this same transaction, so the checkpoint and
   * the channel suspension are durable together. `invalid_state`, changing nothing, when the turn's last
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
   * checkpoints persist. Individual channel suspensions are independent: they
   * neither delay nor are changed by this call. */
  completeSuspend(): StorageResult<StoredSession>;

  /** suspended -> running; every suspended turn whose channel is neither itself
   * `suspended` nor `retired` returns to running in the same transaction and is returned for
   * continuation. Turns of individually suspended channels stay checkpointed:
   * they wait for `resumeChannel`, and a key mismatch on them does not block
   * this call. A turn on a retired channel (only possible in unvalidated data)
   * is left unchanged and never blocks this call. `incompatible`, writing nothing (lifecycle, checkpoints and
   * pending items all unchanged), if any turn being resumed has a
   * compatibilityKey different from the key passed to this open. Already running
   * returns no turns; `suspending` is `invalid_state`. */
  resume(): StorageResult<{ session: StoredSession; turns: StoredTurn[]; unblockedReminders?: import("./reminders.ts").Reminder[] }>;

  /** Stop, in one transaction, by lifecycle:
   * - `running`: every running turn becomes interrupted.
   * - `suspending`: every running AND every checkpointed turn becomes
   *   interrupted and the lifecycle returns to `running`, so this attempt can
   *   no longer commit `suspended`.
   * - `suspended`: nothing changes; clean checkpoints are kept.
   * In every lifecycle, a checkpointed turn on a `suspended` channel is kept: an
   * individually committed suspension is not part of this attempt. A `suspending`
   * channel loses its turn and returns to `open` (it never committed). Unanswered
   * calls become `uncertainCallIds`. Pending items stay pending.
   * Returns the turns interrupted by this call. */
  interruptActive(reason: string): StorageResult<StoredTurn[]>;

  /** Decision 0021. Record that a revocable tool's grant is revoked or
   * restored. Names only: definitions are not stored. A repeat writes nothing.
   * An empty name is `invalid_input`. Allowed in every lifecycle. Returns the
   * sorted revoked set. */
  setToolRevoked(name: string, revoked: boolean): StorageResult<string[]>;

  /** Explicit channel creation. Creation starts no turn and takes nothing.
   * A new ID gets an `open` channel with the optional name. An existing open,
   * suspending or suspended channel with the same name (or both unnamed) returns
   * it with `created: false`; a different name is `already_exists`, so a retry
   * is harmless but nothing is silently renamed. A retired ID is
   * `channel_retired`. Invalid ID or name is `invalid_input`. Allowed in every
   * session lifecycle: it admits no input. */
  createChannel(input: { channelId: string; displayName?: string; policy?: string }): StorageResult<{ channel: StoredChannel; created: boolean }>;

  /** Set (string) or clear (null) the display name only. Channel ID, history,
   * lifecycle and execution state are untouched; a repeat is a no-op success.
   * `not_found`, `channel_retired` and `invalid_input` as for create. Allowed in
   * every session and channel lifecycle state. */
  editChannel(channelId: string, displayName: string | null, policy?: string | null): StorageResult<StoredChannel>;

  /** Begin this channel's individual suspension, independent of the session's.
   * - `open` without a running turn: `suspended` in this transaction (an
   *   existing checkpoint is preserved).
   * - `open` with a running turn: `suspending`. From this commit `acceptItem`,
   *   `beginTurn` and `takePending` refuse the channel with `channel_suspended`
   *   and `finishTurn(completed)` leaves pending items for a checkpoint. The
   *   running turn finishes its iteration, then `checkpointTurn`, `finishTurn` or
   *   `interruptTurn` makes the channel `suspended` in their own transaction.
   * - already `suspending` or `suspended`: returned unchanged.
   * Pending items are never taken or discarded. `not_found`, `channel_retired`.
   * Allowed in every session lifecycle. */
  beginChannelSuspend(channelId: string): StorageResult<StoredChannel>;

  /** Clear the channel's individual suspension. `open` returns unchanged;
   * `suspending` is `invalid_state` (retry after it settles). A retired ID is
   * `channel_retired` and `not_found` an unknown one, both writing nothing.
   * `suspended` becomes
   * `open`; if the channel holds a checkpointed turn and the session lifecycle
   * is `running`, that turn returns to running in the same transaction and is
   * returned, under its original ID, for continuation: `incompatible`, writing
   * nothing, if its compatibilityKey differs from this open's key. With the
   * session `suspending` or `suspended` only the channel suspension is cleared:
   * the checkpoint stays under the session suspension, no turn runs, and the
   * session's own resume continues it. Pending items become eligible once both
   * lifecycles permit. */
  resumeChannel(channelId: string): StorageResult<{ channel: StoredChannel; turn?: StoredTurn; unblockedReminders?: import("./reminders.ts").Reminder[] }>;

  /** Retire the channel: `retired` is final and the ID is reserved. Refused with
   * `channel_busy`, changing nothing, while the channel has a running or
   * checkpointed turn (an unresolved or incompatible checkpoint included) or any
   * pending item, so acceptance and deletion are decided by commit order: an
   * item accepted first blocks deletion; a deletion committed first makes later
   * sends fail `channel_retired`. The timeline, items and turns are kept.
   * Retired already returns it unchanged. `not_found`. Allowed in every
   * session lifecycle and from `suspended`. */
  deleteChannel(channelId: string): StorageResult<StoredChannel & { cancelledReminderIds?: string[] }>;

  /** Withdraw a pending input of this channel, message or notice alike. Competes with
   * `beginTurn`/`takePending` by commit order. Pending (`received`) becomes
   * `withdrawn`: out of pending delivery and out of the timeline, durable across
   * reopen, and a later `acceptItem` retry of the same ID returns it still
   * withdrawn. An item already taken (or later) returns `taken` with its turn ID
   * and changes nothing. Repeating a withdrawal returns `repeated: true`.
   * `not_found` if the item is unknown or belongs to another channel. Allowed in
   * every lifecycle state, so a suspended channel's backlog (which blocks
   * deletion) can be cleared. */
  withdrawItem(channelId: string, itemId: string): StorageResult<WithdrawOutcome>;

  /** Interrupt this specific turn, unconditionally and without waiting for its
   * inference or tools. Only a `running` turn is interrupted: it becomes
   * interrupted with its unanswered calls as `uncertainCallIds`, its taken items
   * and entries kept, pending items left pending, and any later
   * `appendMessage`/`confirmReceipts`/`takePending` refused (`invalid_state`),
   * so a late result is never recorded. A checkpointed or already ended turn
   * returns `interrupted: false` with the turn as it is;
   * in particular a stale ID never affects a newer turn. A `suspending` channel
   * becomes `suspended` in the same transaction, without a checkpoint. The
   * outcome of a competing checkpoint is decided by commit order. `not_found`
   * for a turn ID never issued or one that belongs to another channel. Allowed
   * in every session lifecycle. */
  interruptTurn(channelId: string, turnId: number, reason: string): StorageResult<InterruptOutcome>;

  /** Full neutral read for load/inspection/context. No prompt rendering or SQL
   * leaks through this interface. Reading does not start or resume any work. */
  snapshot(): StorageResult<StorageSnapshot>;

  /** One consistent logical copy. Allowed only when the lifecycle is
   * `suspended`, or it is `running` with no running turn, nothing pending, no
   * checkpointed turn and no `suspending` channel (a `suspended` channel with
   * neither checkpoint nor backlog is fine). `suspending` is always `busy`, even
   * when every turn is already checkpointed or completed, because that state is
   * not yet a clean suspension. Any other case is `busy`. Leaves the session
   * unchanged. */
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
  /** Read the saved configuration without creating or recovering a session. */
  readSavedConfig(): StorageResult<import("./session-file.ts").PortableSessionConfig | undefined>;
  /** Atomically publish the logical archive and validated portable config. */
  importSessionFile(payload: import("./session-file.ts").SessionFilePayload<SessionArchive | SessionArchiveV2 | SessionArchiveV3 | SessionArchiveV4>, options?: { sessionId?: string }): StorageResult<StoredSession>;
  /** Acquire exclusive ownership, then check format and session ID, before any
   * write. A second owner (`owner_conflict`), unreadable or unsupported format
   * and a different session ID (`incompatible`) leave the data untouched.
   * Recovery on reopen is one transaction, and executes nothing:
   * - lifecycle `suspended`: no turn changes. Pending items and checkpoints are
   *   kept for explicit resume.
   * - lifecycle `running` or `suspending` (the prior owner exited without clean
   *   suspension): every running turn, and every checkpointed turn whose channel
   *   is not `suspended`, becomes interrupted with its unanswered calls as
   *   `uncertainCallIds`; lifecycle becomes `running`. Taken items stay with
   *   their turn; pending items stay pending.
   * - in every case a `suspending` channel (its suspension never committed)
   *   returns to `open`; a committed `suspended` channel and its checkpoint
   *   survive. Retired IDs and withdrawn items are untouched.
   * - formats 2 and 3 upgrade to 4 transactionally; legacy policy references
   *   and item signatures are migrated. Incompatible old formats can be read
   *   through an isolated inspection view without modifying the owned file. */
  open(options: StorageOpenOptions): StorageResult<SessionStorage>;

  /** Validate the whole archive, then publish it atomically at this adapter's
   * location, which must not already hold a session (`already_exists`). IDs
   * inside the session are preserved; `sessionId` may replace the session's own.
   * An archive whose lifecycle is `suspending`, or that holds a running turn, is
   * `invalid_archive`: open would interrupt its checkpoints as an unclean exit.
   * So is a `suspending` channel, a checkpointed turn on a non-`suspended`
   * channel while the session is `running`, a withdrawn item with a turn link,
   * a pending item on a retired channel, and, in every session lifecycle, a
   * running or checkpointed turn on a retired channel. Version 1 archives (the persistence
   * revision) import as channels `open` and unnamed; version 2 preserves
   * channel lifecycle, names, withdrawn items and retired IDs.
   * Any failure leaves no partial session. The result is not opened or owned. */
  importArchive(archive: SessionArchive | SessionArchiveV1 | SessionArchiveV2 | SessionArchiveV3 | SessionArchiveV4, options?: { sessionId?: string }): StorageResult<StoredSession>;
}
