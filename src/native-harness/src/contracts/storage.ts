import type { ChannelInput, TurnInput } from "./agent.ts";
import type { ContextEntry } from "./context.ts";
import type { Message } from "./loop.ts";

/** Expected failures never require callers to inspect SQLite or exception text. */
export type StorageErrorCode =
  | "already_exists" | "not_found" | "owner_conflict" | "incompatible"
  | "invalid_input" | "invalid_state" | "closed"
  | "serialization_error" | "storage_failure";

/** A failed mutation leaves no partial domain changes. Do not retry blindly. */
export interface StorageError { code: StorageErrorCode; message: string }

/** A success returns only after commit; a failure exposes no success value. */
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: StorageError };

/** Supplied again on open. Contains no secrets or executable implementations. */
export interface StorageIdentity {
  sessionId: string;
  /** Caller-defined identity of compatible prompt, model and tool configuration.
   * Exact equality is required in revision 1. No automatic config migration. */
  compatibilityKey: string;
}

/** No implicit create-on-open or overwrite. Location is configured on the adapter. */
export interface StorageOpenOptions {
  mode: "create" | "open";
  identity: StorageIdentity;
}

/** Timestamps are UTC strings assigned by storage; never use them as ordering keys. */
export interface StoredSession {
  identity: StorageIdentity;
  /** Storage contract/data format revision, distinct from the RPC version. */
  formatVersion: 1;
  createdAt: string;
}

/** A channel remains available for new turns after failure or interruption. */
export interface StoredChannel {
  channelId: string;
  /** Attribution association only, not proof of authentication or permissions. */
  participantIds: string[];
}

/** Observed caller identity. Participant roles/policies are outside this contract. */
export interface StoredParticipant { participantId: string }

/** These states restore history, not resumable execution checkpoints. */
export type StoredTurnState =
  | { status: "queued" }
  | { status: "running" }
  | { status: "completed" }
  | { status: "failed"; reason: string }
  | { status: "interrupted"; reason: string };

/** Turn identity and original input remain immutable after acceptance. */
export interface StoredTurn {
  input: TurnInput;
  inputSeq: number;
  acceptedAt: string;
  state: StoredTurnState;
}

/** One consistent read; records do not alias storage or caller-owned objects. */
export interface StorageSnapshot {
  session: StoredSession;
  channels: StoredChannel[];
  participants: StoredParticipant[];
  /** Ordered by allocated turn ID, which is acceptance order, not completion order. */
  turns: StoredTurn[];
  /** All entries in increasing global seq order, suitable for the existing builder. */
  history: ContextEntry[];
}

/** Only the adapter's owner closes this handle; borrowers must not close it. */
export interface SessionStorage {
  /** Atomically upsert channel/participant/membership, allocate a positive safe
   * integer turn ID, and save queued turn + attributed participant input.
   * Match today's `Participant: <JSON identity>\n\n<text>` input rendering.
   * Reject empty routing/content without consuming work.
   * itemId is retained as metadata only: revision 1 does NOT deduplicate retries.
   * IDs and history seq never collide with earlier committed records on reopen. */
  acceptInput(input: ChannelInput): StorageResult<StoredTurn>;

  /** queued -> running, only for the earliest unfinished turn on the channel.
   * Reject concurrent starts on that channel; other channels are independent. */
  startTurn(turnId: number): StorageResult<StoredTurn>;

  /** Append only to a running turn. Storage assigns seq/time/channel/turn/from.
   * Assistant messages are from agent; tool results are from tool. Calls are
   * recorded before execution. A new assistant response requires all prior calls
   * in the turn to have results. Tool results must match an unanswered call in
   * that turn; duplicate call IDs/results are invalid. Each operation is atomic.
   * Reject non-JSON data, including unsupported opaque provider state, without
   * silently discarding it. Preserve supported provider state unchanged. */
  appendMessage(
    turnId: number,
    message: Extract<Message, { role: "assistant" | "tool" }>,
  ): StorageResult<ContextEntry>;

  /** running -> completed/failed. Completion requires a recorded final assistant
   * response with no calls and no unanswered calls. Failure retains all history
   * and leaves the channel available for new turns. Neither outcome implies output delivery.
   * Terminal transitions cannot be overwritten or applied twice. */
  finishTurn(
    turnId: number,
    outcome: { status: "completed" } | { status: "failed"; reason: string },
  ): StorageResult<StoredTurn>;

  /** Full neutral read for startup/inspection/context. No prompt rendering or SQL
   * leaks through this interface. Reading does not start or resume any work. */
  snapshot(): StorageResult<StorageSnapshot>;

  /** Release ownership/resources, never erase history. Idempotent after success.
   * Caller must first stop using the handle from live execution. This operation
   * does not wait for or cancel tools; unfinished turns remain for interruption
   * recovery on reopen. This is NOT suspend or forced stop.
   * Failure must not advertise released ownership. Other calls after successful
   * close return closed. Process death may still close an unclean session. */
  close(): StorageResult<void>;
}

/** Adapter configured with a location (for example a SQLite path) by assembly.
 * open acquires exclusive ownership before reading/mutating session state.
 * Validate identity/format before recovery; incompatible opens must not mutate.
 * On reopen, atomically mark prior queued/running turns interrupted and preserve
 * history before returning. Channels remain usable. No tool/model execution.
 * A second owner fails; close/process exit releases ownership. Creation and
 * recovery are atomic. Returned values and later reads are defensive copies.
 * Methods are synchronous, with no transaction spanning external async work.
 * Commit notifications/output are wired by composition after success, never
 * from inside a transaction. No durable event replay is promised. */
export interface SessionStorageAdapter {
  open(options: StorageOpenOptions): StorageResult<SessionStorage>;
}
