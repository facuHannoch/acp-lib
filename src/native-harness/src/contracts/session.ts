import type { SessionAgent, ActiveTurn, TurnExecutor } from "./agent.ts";
import type { Model, ExecuteTool, ToolDefinition } from "./loop.ts";
import type { SharedContextStore } from "./context.ts";
import type { EventSink, SessionEventSink } from "./events.ts";
import type {
  ChannelLifecycle, InterruptOutcome, SessionLifecycle, SessionStorage, StorageError, StorageSnapshot, WithdrawOutcome,
} from "./storage.ts";

export interface TurnServices { model: Model; tools: readonly ToolDefinition[]; executeTool: ExecuteTool }
/** Derived from one storage snapshot. The session lifecycle, each channel's
 * lifecycle, each turn status and the pending input are reported independently
 * (decision 0014). `working`: a running turn exists, or an item is pending on a
 * channel that may run (session `running`, channel `open`). `idle`: lifecycle
 * running and neither. Input pending on a suspended channel, or while the
 * session is not running, never makes `execution` report `working`; it shows as
 * `waitingForResume` instead. `unresolvedInterruption` marks a channel whose
 * most recent turn was interrupted (or failed) and has not been followed by
 * another turn; it reports, and never blocks, new work on that channel. */
export interface SessionStatus {
  sessionId: string;
  revision: number;
  lifecycle: SessionLifecycle;
  /** `stopped`: this process has closed admission and will start no more work. */
  execution: "idle" | "working" | "suspending" | "suspended" | "stopped";
  channels: ChannelStatus[];
}

export interface ChannelStatus {
  channelId: string;
  displayName?: string;
  lifecycle: ChannelLifecycle;
  /** A running turn, or a checkpointed one (`suspended`). */
  activeTurn?: { turnId: number; status: "running" | "suspended" };
  /** Pending (never taken, not withdrawn) items in acceptance order. */
  pendingItemIds: string[];
  /** True when pending items or a checkpointed turn exist that cannot run until
   * a resume: the channel is `suspending`/`suspended`, or the session is not
   * `running`. Clearing one lifecycle does not clear it while the other holds. */
  waitingForResume: boolean;
  unresolvedInterruption?: { turnId: number; status: "failed" | "interrupted"; reason: string; uncertainCallIds: string[] };
}

/** `stopped`: stop ended the operation; nothing was suspended or resumed. */
export type LifecycleResult = { ok: true; status: SessionStatus }
  | { ok: false; error: StorageError | { code: "stopped"; message: string } };

/** Outcome of a channel control. `revision` is the storage revision that
 * includes it. `stopped`: this process stopped before the control committed. */
export type ControlResult<T> = { ok: true; value: T; revision: number }
  | { ok: false; error: StorageError | { code: "stopped"; message: string } };

/** Per-channel controls (decision 0014), each atomic in storage and independent
 * of the session lifecycle and of other channels. Failures use the storage error
 * codes of the matching `SessionStorage` method. */
export interface ChannelControls {
  /** Explicit creation; starts no turn. Repeating the same request returns
   * `created: false`. A different name for an existing channel is `already_exists`;
   * a retired ID is `channel_retired`. */
  create(input: { channelId: string; displayName?: string }): ControlResult<{ channel: ChannelStatus; created: boolean }>;
  /** Display name only (null clears). */
  edit(channelId: string, displayName: string | null): ControlResult<ChannelStatus>;
  /** Close the channel to input at once, let its active iteration finish, then
   * resolve once `suspended` is committed: with a checkpoint if the turn needs
   * another inference, with a completed turn if it can finish, or with no
   * checkpoint if the turn was interrupted meanwhile. Pending input is kept.
   * Concurrent and repeated calls observe the same transition. Resolves
   * `stopped` if stop arrives first; the unfinished suspension never commits. */
  suspend(channelId: string): Promise<ControlResult<ChannelStatus>>;
  /** Clear the channel's suspension. Continues a checkpoint under its original
   * turn ID and starts pending input only when the session is `running`; during a
   * session suspension only the channel suspension is cleared and nothing runs.
   * `incompatible` leaves the channel suspended and its checkpoint intact. */
  resume(channelId: string): ControlResult<ChannelStatus>;
  /** Retire the channel when it has no active or checkpointed turn and nothing
   * pending (`channel_busy` otherwise). The ID is reserved; history is kept. */
  delete(channelId: string): ControlResult<ChannelStatus>;
  /** Withdraw an untaken message or notice. `taken` names the owning turn when take won. */
  withdraw(channelId: string, itemId: string): ControlResult<WithdrawOutcome>;
  /** Interrupt exactly this turn, aborting its signal and ending it without
   * waiting for its inference or tools; late results are fenced. `interrupted:
   * false` for a checkpointed or ended turn, which is left untouched. When
   * `reason` is omitted the stored reason is exactly `"interrupted by request"`. */
  interrupt(channelId: string, turnId: number, reason?: string): ControlResult<InterruptOutcome>;
}

export interface PersistentSessionOptions {
  systemPrompt: string;
  /** Opened and later closed by the caller. Recovery already ran in open. */
  storage: SessionStorage;
  configureTurn(turn: ActiveTurn, notify: SessionAgent["notify"]): TurnServices;
  wrapTurn?: (run: TurnExecutor) => TurnExecutor;
}

/** Creating the session executes nothing: it can be inspected, loaded and
 * exported first. Opening, starting and resuming are separate actions. */
export interface PersistentSession {
  agent: SessionAgent;
  /** Channel controls (decision 0014). */
  channels: ChannelControls;
  /** Read-only timeline projection for the context builder and inspector. */
  store: Pick<SharedContextStore, "snapshot" | "subscribe">;
  snapshot(): StorageSnapshot;
  status(): SessionStatus;
  /** Make pending items eligible: begin turns for channels with pending input
   * when the lifecycle is running and the channel is `open`. Does not resume a
   * suspended session or channel. Callers
   * that owe a load response deliver it before calling start. Idempotent. */
  start(): void;
  /** Resolves when `suspended` is committed, after in-flight iterations settle.
   * Concurrent and repeated calls observe the same transition. If stop arrives
   * first, resolves `stopped` and `suspended` is never committed. */
  suspend(): Promise<LifecycleResult>;
  /** Explicit resume: continues checkpointed turns of channels that are not
   * individually suspended, then starts pending input of those channels. An
   * individually suspended channel stays suspended (and its checkpoint, even an
   * incompatible one, does not block this call). */
  resume(): LifecycleResult;
  /** Immediate: close admission in this process, abort inference and tools,
   * and commit storage `interruptActive`. While running that interrupts every
   * running turn; while suspending it also interrupts turns checkpointed in
   * this attempt and returns the lifecycle to running; a suspended session keeps
   * its checkpoints. Checkpoints committed by an individual channel suspension
   * are always kept and a channel still `suspending` returns to `open`. Pending
   * items stay pending. Does not wait for the
   * iteration and is not suspension. Late results are fenced by storage. */
  stop(reason: string): SessionStatus;
  subscribe(listener: EventSink): () => void;
  subscribeSession(listener: SessionEventSink): () => void;
}
