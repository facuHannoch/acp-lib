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
 * This file declares the turn path (Brief A2). The lifecycle, settings and capability members of the
 * full interface, and `HarnessController implements ConversationController`, come with Brief B1.
 */
import type { ClientPrompt } from "../agent-client.ts";
import type { ConnectResult } from "../client.ts";
import type { AgentControllerStartEvent } from "../controller.ts";
import type { MeteredOperationKind } from "../metering/record.ts";
import type { OutputListener } from "../operations/contracts.ts";
import type { SupervisedProvider } from "../operations/supervisor.ts";
import type { PromptHandlers } from "../types.ts";

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
  /**
   * Turn reports: `turn_started` whenever a turn starts (because of a `send`, or on the backend's
   * own), and, for backend-scheduled controllers only, `turn_took` when more items are folded into
   * a running turn. The controller never reports a turn's end: that is its prepared turn's
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
}

/** A run of messages put in by the session. */
export interface TurnRun {
  /**
   * Session-scheduled: the session's id for the run, its first message's id (required).
   * Backend-scheduled: absent; the backend assigns turn ids.
   */
  readonly turnId?: string;
  /** Every message the run carries, in queue order: one, or several for a combined steer run. */
  readonly messageIds: readonly string[];
  readonly operationKind: MeteredOperationKind;
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
  /** False while replaying output held for a turn that already ended; the stall check applies only while live. */
  readonly live: boolean;
}

/** Why a turn started: the messages it carries, or backend items (for a turn nobody prompted). */
export type TurnCause =
  | { readonly kind: "messages"; readonly messageIds: readonly string[] }
  | { readonly kind: "items"; readonly items: readonly unknown[] };

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

export type TurnEvent = TurnStarted | TurnTook;

/** A start's result: `{ sessionId, resumed }`, as today. */
export type StartResult = ConnectResult;

/** A start's progress events, as today (`AgentControllerStartEvent`; B1 renames it). */
export type ControllerStartEvent = AgentControllerStartEvent;
