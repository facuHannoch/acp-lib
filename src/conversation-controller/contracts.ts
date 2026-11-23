/**
 * What a conversation needs from its backend: the turn members of `ConversationController`
 * (controller-interface spec, `library/11-11-SPEC-controller-interface.md`, The interface).
 *
 * The ownership rule: **the controller owns provider execution; the session owns the conversation's
 * outcome.** A run of messages goes in with `send`; the controller reports when a turn starts (and,
 * for backend-scheduled controllers, when more items are folded into a running one), never when it
 * ends; the session prepares each reported turn with `prepareTurn`, runs it under its supervisor,
 * and announces its completion or failure after finalization.
 *
 * The turn members (Brief A2), then the lifecycle, settings and capability members and the optional
 * members (Brief B1). `HarnessController implements ConversationController`; a native controller
 * (later) implements the core and leaves the optional members absent.
 */
import type { NativeTurnMetering } from "../metering/native/source.ts";
import type { ClientPrompt } from "../agent-client.ts";
import type { ConnectResult } from "../client.ts";
import type { AgentMode, ControllerStartEvent, HarnessController } from "../controller.ts";
import type { ConfigOptions } from "../config-options.ts";
import type { ConversationCapabilities } from "./capabilities.ts";
import type { MeteredOperationKind } from "../metering/record.ts";
import type { OutputListener, SupervisedProvider } from "../operations/contracts.ts";
import type { CombinedMessage } from "../steering/contracts.ts";
import type { InternalSessionCommand, PromptHandlers, SessionListPage } from "../types.ts";

/** The turn path of a conversation's backend. */
export interface ConversationController {
  /**
   * Puts a run of messages in. Resolves when the backend has accepted the run.
   *
   * Session-scheduled (the `HarnessController`): makes no provider call; reports `turn_started` for
   * the run synchronously, inside the call, with `sentBySession: true`, and returns an already
   * resolved promise. `run.turnId` is required (a run without one is an error). So the session
   * registers the run's state before calling `send`.
   *
   * Backend-scheduled (native, later): pushes each message to the backend and resolves once it has
   * accepted them; the backend starts turns as it decides and assigns their ids, so `send` promises
   * no turn and ignores `run.turnId`.
   *
   * `run.messageIds` is non-empty and in queue order; an id that is repeated is an error (the
   * controller throws).
   */
  send(run: TurnRun): Promise<void>;
  /** Requests withdrawal of a submitted input, true only when confirmed. */
  withdrawInput?(messageId: string): Promise<boolean>;
  /**
   * Turn reports: `turn_started` whenever a turn starts (because of a `send`, or on the backend's
   * own), and, for backend-scheduled controllers only, `turn_took` when more items are folded into
   * a running turn. Native controllers also report committed item receipts and confirmed input withdrawal.
   * The controller never reports a turn's end: that is its prepared turn's
   * `prompt()` settling.
   */
  subscribeTurns(listener: (event: TurnEvent) => void): () => void;
  /**
   * Prepares a reported turn for the supervisor. **Starts nothing:** the provider work (or, for a
   * held turn, the replay of its output) starts when the returned turn's `prompt()` is called, after
   * the supervisor has subscribed to its output (the attachment barrier).
   */
  prepareTurn(turnId: string, content: TurnContent): PreparedTurn;
  /**
   * Ends a reported turn the session won't run (provider connection failed, a pre-dispatch record
   * failed, the conversation stopped): releases the controller's bookkeeping for it and discards any
   * output held for it. Idempotent; a call for an unknown or already executed turn does nothing.
   * Not a cancel: it never stops provider work (that is `cancel` / `forceStop`).
   */
  abandonTurn(turnId: string, reason: unknown): void;
  /** Controller-wide supervision signals, as today. A prepared turn's own `subscribeOutput` is per turn. */
  subscribeOutput(listener: OutputListener): () => void;
  /** Cancels the turn executing now, as today. */
  cancel(): void;
  /** Stops the backend itself (controller-wide); every open prepared turn rejects. */
  forceStop(): Promise<void>;
  /**
   * Prepares an internal prompt (handoff summary, recap, recovery seed): not a turn, no turn events.
   * Starts nothing until `prompt()`; the session runs it under the same supervisor with its own stall
   * limits. Absent when the controller type doesn't support internal prompts.
   */
  prepareInternalPrompt?(content: TurnContent): SupervisedProvider;

  // --- lifecycle --------------------------------------------------------------------------------
  /**
   * Starts the backend (resuming its context when it can). Resolves with `{ sessionId, resumed }`:
   * `resumed: true` means the backend reattached an existing context. A start can succeed without a
   * context (PTY mode; a working connection whose session creation failed, e.g. for authentication):
   * `{ sessionId: "", resumed: false }`. `onProgress` gets `initialized` once the backend answered its
   * handshake, and `internal_session_acquired` only when a context actually exists.
   */
  /** Optional observation-only attachment. Disposing it leaves the backend turn running. */
  readonly attachmentConnected?: boolean;
  attachObservation?(): Promise<{ dispose(): void }>;
  start(onProgress?: (event: ControllerStartEvent) => void): Promise<StartResult>;
  /** Starts with a fresh context, never resuming. Same result and progress as `start`. */
  startFresh(onProgress?: (event: ControllerStartEvent) => void): Promise<StartResult>;
  stop(): Promise<void>;
  readonly isConnected: boolean;
  subscribeConnection(listener: () => void): () => void;
  /** How long a cancelled turn gets before the supervisor escalates; undefined when the adapter sets none. */
  readonly cancelGraceMs: number | undefined;

  // --- settings and usage -----------------------------------------------------------------------
  /** May be non-empty before `start`, and change after it. */
  readonly configOptions: ConfigOptions;
  setConfig(id: string, value: unknown): Promise<void>;
  subscribeUsageUpdate(listener: UsageListener): () => void;
  readonly currentSessionId: string | null;
  /** What the backend offers, in neutral terms. Safe to read before connecting and in PTY mode. */
  readonly conversationCapabilities: ConversationCapabilities;

  // --- optional: absent when the controller type doesn't support them ---------------------------
  // Paired members are present together or not at all. A present member says the controller type
  // can do it; whether it can right now depends on the connection (`conversationCapabilities`).
  readonly availableCommands?: readonly InternalSessionCommand[];
  subscribeAvailableCommands?(listener: (commands: readonly InternalSessionCommand[]) => void): () => void;
  readonly currentMode?: AgentMode;
  setMode?(mode: AgentMode): Promise<StartResult>;
  reconnect?(sessionId: string): Promise<StartResult>;
  listSessions?(): Promise<SessionListPage>;
  bridge?(...args: Parameters<HarnessController["bridge"]>): ReturnType<HarnessController["bridge"]>;
  authenticate?(...args: Parameters<HarnessController["authenticate"]>): ReturnType<HarnessController["authenticate"]>;
}

/** A listener for raw usage updates (`usage_update` for ACP) with the session they came from. */
export type UsageListener = (update: unknown, sessionId: string | null) => void;

/** A run of messages put in by the session. */
export interface TurnRun {
  /**
   * Session-scheduled: the session's id for the run, its first message's id (required).
   * Backend-scheduled: absent; the backend assigns turn ids.
   */
  readonly turnId?: string;
  /** Every message the run carries, in queue order: one, or several for a combined steer run. */
  readonly messageIds: readonly string[];
  /**
   * The messages themselves, in `messageIds` order: the objects the queue holds (a combined steer run lists each original
   * message), so a backend-scheduled controller gets what the user wrote without reaching back into the session. ACP
   * controllers ignore it: the session builds their content and passes it in `prepareTurn`.
   */
  readonly messages: readonly CombinedMessage[];
  readonly operationKind: MeteredOperationKind;
  /** Claims the local dispatch boundary for a native input, false if already withdrawn. */
  readonly beginInput?: (messageId: string) => boolean;
}

/** What a prepared turn runs with. */
export interface TurnContent {
  /** What the backend is told. ACP only; built by the session at turn time. */
  readonly input?: ClientPrompt;
  /** The session's recording handlers (stream, activity, permissions); used by every backend. */
  readonly handlers: PromptHandlers;
}

/**
 * One reported turn, prepared. `prompt()` starts it and settles with its result: the single
 * authority for the provider's outcome. `subscribeOutput`, `cancel` and `forceStop` are this turn's
 * own (per-turn supervision): its signals reach only it; `cancel` cancels only it and does nothing
 * once it has ended in the backend; `forceStop` stops the backend itself.
 */
export interface PreparedTurn extends SupervisedProvider {
  readonly turnId: string;
  /** Pulls usage for this exact wire turn at the operation's close. */
  readonly nativeMetering?: NativeTurnMetering;
  /** False while replaying output held for a turn that already ended; the stall check applies only while live. */
  readonly live: boolean;
}

/** A reference to one backend item that started or joined a turn (a worker reply, another channel's message...). */
export type ItemRef = unknown;

/**
 * Why a turn started: the messages it carries, the backend items it took, or both (a native backend takes everything
 * waiting at a model call, so a worker reply and a user message often land in one turn). At least one is present.
 */
export type TurnCause =
  | { readonly messageIds: readonly string[]; readonly items?: readonly ItemRef[] }
  | { readonly messageIds?: readonly string[]; readonly items: readonly ItemRef[] };

/** A turn started. `sentBySession` is true for a turn started by the session's `send`. */
export interface TurnStarted {
  readonly kind: "turn_started";
  readonly turnId: string;
  readonly cause: TurnCause;
  readonly sentBySession: boolean;
}

/** More items folded into a running turn (backend-scheduled controllers only; native steering). */
export interface TurnTook {
  readonly kind: "turn_took";
  readonly turnId: string;
  readonly cause: TurnCause;
}

/** A live advance in the harness's evidence for one or more items. */
export interface ItemsReceipt {
  readonly kind: "items_receipt";
  readonly turnId: string;
  readonly itemIds: readonly string[];
  readonly milestone: "delivered" | "seen";
}

export type TurnEvent = TurnStarted | TurnTook | ItemsReceipt | { readonly kind: "input_withdrawn"; readonly messageId: string };

/** A start's result: `{ sessionId, resumed }`, as today. */
export type StartResult = ConnectResult;

export type { ControllerStartEvent };
