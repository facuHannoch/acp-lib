import { nativeConversationCapabilities } from "./capabilities.ts";
import { advanceItemReceipts } from "./item-receipts.ts";
import { terminalNativeTurns } from "./metering.ts";
import { NativeInferenceSource } from "../metering/native/source.ts";
import { nativeConversationStopping, nativeProviderTurnEnded, refuseNativeOnClose } from "../permissions/conversation.ts";
import { runNativeApproval } from "./approvals.ts";
import { recordingPermissionHandlers } from "../permissions/policy.ts";
/**
 * The native `ConversationController`: one conversation as one channel of the Agent's harness session
 * (acp-client integration spec, Controller behavior). Translation only: the shared `NativeHarnessHost`
 * owns the process, the open sequence and the saved submissions; the harness owns session and channel
 * state, the take rules, execution and permissions.
 *
 * Backend-scheduled: `send` only hands messages over and resolves on durable acceptance; the harness
 * decides which turn takes which input and reports it (`turn_started`, `turn_took`). A turn can produce
 * output before the session attaches its supervisor, so each reported turn holds its events (and its
 * outcome, if it ends first) until the prepared turn's `prompt()` is called. Preparing starts nothing;
 * the harness's `turn_ended`, or the reconciled outcome after a reopen, settles that prompt once.
 */
import type { ChannelEvent, StoredMessage, TurnStatus } from "../native-harness/src/client.ts";
import type { ConversationCapabilities } from "../conversation-controller/capabilities.ts";
import type {
  ConversationController,
  PreparedTurn,
  StartResult,
  TurnCause,
  TurnContent,
  TurnEvent,
  TurnRun,
  UsageListener,
} from "../conversation-controller/contracts.ts";
import type { ConfigOptions } from "../config-options.ts";
import { UnsupportedError } from "../errors.ts";
import { noopLogger, type Logger } from "../logger.ts";
import { isMediaPart, mediaKind, type MediaKind } from "../media/parts.ts";
import type { OutputListener, ProviderOutput } from "../operations/contracts.ts";
import type { PromptHandlers, PromptResult, ResponseMessage } from "../types.ts";
import type { ChannelPort, ChannelView, NativeHarnessHost } from "./host.ts";

/** A native turn that ended failed or interrupted without this conversation cancelling it. */
export class NativeTurnError extends Error {
  /** Tool calls recorded with no recorded result. The harness never replays them; neither does the host. */
  readonly uncertainCalls: readonly string[];
  constructor(readonly outcome: "failed" | "interrupted", message: string, uncertainCalls: readonly string[] = []) {
    super(message);
    this.name = "NativeTurnError";
    this.uncertainCalls = uncertainCalls;
  }
}

export interface NativeControllerConfig {
  readonly host: NativeHarnessHost;
  /** The channel id: the conversation's id, stable for its lifetime. */
  readonly channelId: string;
  /** The sender recorded for a message that names no participant. */
  readonly defaultSender?: string;
  /** True when the conversation has existing history (acp-client's own records); reported as `resumed`. */
  readonly resumed?: boolean;
  readonly logger?: Logger;
}

type Outcome = { outcome: "completed" | "failed" | "interrupted"; error?: string; uncertainCalls?: readonly string[] };
type TurnScoped = Extract<ChannelEvent["event"], { turnId: string }>;

interface Turn {
  readonly id: string;
  readonly harnessId: string;
  readonly items: Set<string>;
  held: TurnScoped[];
  sink: ((event: TurnScoped) => void) | null;
  readonly completed: Set<string>;
  readonly approvals: Set<string>;
  ended: Outcome | null;
  terminalOnWire?: boolean;
  stoppedBeforeResult?: true;
  /** This conversation asked for the interruption, so an interrupted end is a cancel, not a failure. */
  cancelRequested: boolean;
  /** Given up locally (`forceStop`, `abandonTurn`, `stop`): later events only release bookkeeping. */
  released: boolean;
  fail: ((error: Error, stopping?: boolean) => void) | null;
}

const sessionTurnId = (harnessId: string) => `native-turn-${harnessId}`;
const NO_OPTIONS = new Map() as ConfigOptions;
export class NativeController implements ConversationController, ChannelPort {
  readonly #host: NativeHarnessHost;
  readonly #channel: string;
  readonly #config: NativeControllerConfig;
  readonly #log: Logger;
  readonly #turns = new Map<string, Turn>();
  readonly #turnListeners = new Set<(event: TurnEvent) => void>();
  readonly #outputListeners = new Set<OutputListener>();
  readonly #connectionListeners = new Set<() => void>();
  readonly #receipts = new Map<string, "delivered" | "seen">();
  /** Items of turns the last view listed, so a checkpoint resumed later can name what it took. */
  #viewTurns = new Map<string, readonly string[]>();
  #detach: (() => void) | null = null;
  #unsubscribeHost: (() => void) | null = null;
  #stopped = false;
  #attachment: Promise<void> | null = null;
  #attachmentHandle?: { dispose(): void };
  #attachmentApprovals = new AbortController();
  #usage?: NativeInferenceSource;

  constructor(config: NativeControllerConfig) {
    this.#config = config;
    this.#host = config.host;
    this.#channel = config.channelId;
    this.#log = config.logger ?? noopLogger;
  }

  get channelId(): string { return this.#channel; }

  async start(): Promise<StartResult> {
    this.#stopped = false;
    if (!this.#detach) {
      const detach = this.#host.attach(this.#channel, this, true);
      this.#detach = detach;
      this.#attachmentHandle = { dispose: () => { if (this.#detach === detach) this.disposeAttachment(); } };
      this.#attachment = this.#host.observeAttachment(this.#channel, this).catch(error => {
        if (this.#detach === detach) this.disposeAttachment();
        throw error;
      });
    }
    await this.#attachment;
    this.#unsubscribeHost ??= this.#host.subscribeState(() => this.#notifyConnection());
    this.#notifyConnection();
    return { sessionId: this.#host.sessionId, resumed: this.#config.resumed ?? false };
  }

  /**
   * Unsupported: a native conversation shares its agent's session and timeline, and neither an
   * agent-wide nor a channel context reset exists yet (`conversationCapabilities.freshContext` is
   * false). Throws before touching anything: the channel, session and timeline are unchanged.
   */
  startFresh(): Promise<StartResult> {
    return Promise.reject(new UnsupportedError("a native conversation cannot start a fresh context: the harness has no context reset"));
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#closeAttachmentApprovals(true);
    for (const turn of [...this.#turns.values()].filter(turn => !turn.ended && !turn.released)) {
      turn.cancelRequested = true;
      await this.#host.interrupt(this.#channel, turn.harnessId, "interrupted by the conversation");
    }
    this.#stopped = true;
    this.#release(new Error("the conversation stopped"), false, true);
    this.disposeAttachment();
  }

  async attachObservation(): Promise<{ dispose(): void }> {
    await this.start();
    if (!this.#attachmentHandle) throw new Error("Attachment was disposed during observation");
    return this.#attachmentHandle;
  }

  disposeAttachment(): void {
    this.#closeAttachmentApprovals();
    this.#attachmentApprovals = new AbortController();
    this.#attachment = null;
    this.#attachmentHandle = undefined;
    this.#detach?.();
    this.#detach = null;
    this.#unsubscribeHost?.();
    this.#unsubscribeHost = null;
    this.#notifyConnection();
  }

  #closeAttachmentApprovals(stopping = false): void {
    this.#attachmentApprovals.abort(stopping ? nativeConversationStopping : undefined);
    for (const turn of this.#turns.values()) this.#refuseHeldApprovals(turn, stopping);
  }

  #refuseHeldApprovals(turn: Turn, stopping = false): void {
    for (const event of turn.held) if (event.type === "approval_requested") {
      refuseNativeOnClose(this.#host.approvalFor(event), stopping, () => this.#log);
    }
  }

  /** True unless this conversation stopped or the host gave up: a stopped process is started by the next work. */
  get isConnected(): boolean { return !this.#stopped && this.#host.state !== "failed"; }
  subscribeConnection(listener: () => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }
  #notifyConnection(): void {
    for (const listener of [...this.#connectionListeners]) { try { listener(); } catch { /* observer */ } }
  }
  readonly cancelGraceMs = undefined;

  get attachmentConnected(): boolean { return this.#detach !== null; }
  get attachmentStatus(): "disconnected" | "offline" | "suspended" | "online" {
    if (!this.#detach) return "disconnected";
    if (this.#host.state !== "running") return "offline";
    return this.#host.channel(this.#channel)?.lifecycle === "suspended" || this.#host.sessionLifecycle === "suspended"
      ? "suspended" : "online";
  }

  history(limit?: number, cursor?: string) {
    return this.#host.conversationMessages(cursor === undefined ? { channel: this.#channel, limit } : { channel: this.#channel, cursor, limit });
  }

  catchUp(after: string, commit: Parameters<NativeHarnessHost["catchUp"]>[2], signal?: AbortSignal) {
    return this.#host.catchUp(this.#channel, after, commit, signal);
  }

  readonly configOptions: ConfigOptions = NO_OPTIONS;
  setConfig(id: string): Promise<void> {
    return Promise.reject(new UnsupportedError(`a native conversation has no config option ${id}`));
  }
  /** Usage reports are not forwarded yet: the harness keeps them per model call (`session/model-calls`). */
  subscribeUsageUpdate(_listener: UsageListener): () => void { return () => undefined; }
  get currentSessionId(): string | null { return this.#host.sessionId; }
  get conversationCapabilities(): ConversationCapabilities {
    return nativeConversationCapabilities();
  }

  /** The last confirmed delivery milestone of an input this conversation sent, if any. */
  receiptOf(messageId: string): "delivered" | "seen" | undefined { return this.#receipts.get(messageId); }

  /**
   * Pushes each message as an input of the channel, in order, under its own id. Resolves once the
   * harness has stored every one durably (a receipt, or the reconciled state after a reopen). Promises
   * no turn and ignores `run.turnId`: the harness reports which turn takes each input.
   */
  async send(run: TurnRun): Promise<void> {
    if (new Set(run.messageIds).size !== run.messageIds.length) throw new Error("a run repeats a message id");
    if (this.#stopped) throw new Error("the conversation is stopped");
    const media = this.conversationCapabilities.backend?.media;
    const requireMedia = (kind: MediaKind) => {
      if (!media?.[kind]) throw new UnsupportedError(`a native conversation does not support ${kind} input`);
    };
    // Validate the whole run before the host can persist or deliver any of its messages.
    for (const message of run.messages) {
      for (const part of message.messageParts ?? []) {
        if (isMediaPart(part)) requireMedia(part.mimeType === "image/svg+xml" ? "file" : part.kind);
      }
      for (const attachment of message.attachments ?? []) requireMedia(mediaKind(attachment.mimeType));
    }
    // The harness assigns turn ids after acceptance. Use the input's id before any push.
    for (const message of run.messages) {
      if (message.beforeDispatch) await message.beforeDispatch(message.id);
    }
    if (this.#stopped) throw new Error("the conversation is stopped");
    if (!this.#detach) await this.start();
    for (const message of run.messages) {
      if (run.beginInput?.(message.id) === false) continue;
      await this.#host.push({
        id: message.id,
        channel: this.#channel,
        sender: message.participantId ?? this.#config.defaultSender ?? "user",
        text: message.text,
      });
    }
  }

  withdrawInput(messageId: string, onTaken?: (turnId?: string) => void): Promise<boolean> {
    return this.#host.withdrawSubmission(this.#channel, messageId, onTaken && (id => onTaken(id === undefined ? undefined : sessionTurnId(id))));
  }
  subscribeTurns(listener: (event: TurnEvent) => void): () => void {
    this.#turnListeners.add(listener);
    return () => this.#turnListeners.delete(listener);
  }
  #report(event: TurnEvent): void {
    for (const listener of [...this.#turnListeners]) listener(event);
  }

  /** Which of a turn's items are messages this conversation sent; the rest are backend items. */
  #cause(items: readonly string[]): TurnCause {
    const messageIds = items.filter((id) => this.#host.records.submission(id)?.channel === this.#channel);
    const others = items.filter((id) => !messageIds.includes(id)).map((id) => ({ id }));
    if (messageIds.length && others.length) return { messageIds, items: others };
    return messageIds.length ? { messageIds } : { items: others };
  }

  #begin(harnessId: string, items: readonly string[]): Turn {
    const turn: Turn = {
      id: sessionTurnId(harnessId), harnessId, items: new Set(items), held: [], sink: null,
      completed: new Set(), approvals: new Set(), ended: null, cancelRequested: false, released: false, fail: null,
    };
    this.#turns.set(turn.id, turn);
    this.#report({ kind: "turn_started", turnId: turn.id, cause: this.#cause(items), sentBySession: false });
    return turn;
  }

  event(event: ChannelEvent): void {
    const payload = event.event;
    if (payload.type === "channel_state") { this.#notifyConnection(); return; }
    if (payload.type === "approval_closed") return; // The host settles the shared approval ticket.
    if (payload.type === "item_withdrawn") { this.#report({ kind: "input_withdrawn", messageId: payload.item }); return; }
    if (payload.type === "turn_started") {
      if (!this.#turns.has(sessionTurnId(payload.turnId))) this.#begin(payload.turnId, payload.items);
      return;
    }
    let turn = this.#turns.get(sessionTurnId(payload.turnId));
    // A checkpoint from before this connection continues under its original id: the first this
    // conversation hears of it is the resume.
    if (!turn && payload.type === "turn_resumed") turn = this.#begin(payload.turnId, this.#viewTurns.get(payload.turnId) ?? []);
    if (!turn) { this.#log.warn("native_event_for_unknown_turn", { channel: this.#channel, turnId: payload.turnId, type: payload.type }); return; }
    if (payload.type === "turn_took") {
      // The association holds even when it arrives before the push response: the session matches by id.
      for (const item of payload.items) turn.items.add(item);
      if (!turn.released) this.#report({ kind: "turn_took", turnId: turn.id, cause: this.#cause(payload.items) });
      return;
    }
    this.#accept(turn, payload);
  }

  #accept(turn: Turn, event: TurnScoped, terminalOnWire = true): void {
    if (turn.ended) return; // terminal once: a second end (live after reconciled, or the reverse) changes nothing
    if (event.type === "items_receipt") {
      const itemIds = advanceItemReceipts(this.#receipts, event.items, event.milestone);
      if (itemIds.length && !turn.released) this.#report({ kind: "items_receipt", turnId: turn.id, itemIds, milestone: event.milestone });
      return;
    }
    if (event.type === "message_completed" && event.messageId !== undefined) {
      if (turn.completed.has(event.messageId)) return;
      turn.completed.add(event.messageId);
    }
    if (event.type === "turn_ended") {
      turn.terminalOnWire = terminalOnWire;
      turn.ended = { outcome: event.outcome, ...(event.error === undefined ? {} : { error: event.error }), ...(event.uncertainCalls ? { uncertainCalls: event.uncertainCalls } : {}) };
      // Terminal for every input the turn took: nothing is left to retry.
      this.#host.settle(turn.items);
    }
    if (turn.released) {
      if (turn.ended) this.#turns.delete(turn.id);
      return;
    }
    if (turn.sink) turn.sink(event);
    else turn.held.push(event);
  }

  /**
   * The view after an open. Turns this conversation was following get the outcome they reached while it
   * was not listening, with any committed reply it missed restored by message id; nothing is repeated.
   * A turn it never heard of that took one of its unsettled inputs is reported now, already ended.
   */
  reconcile(view: ChannelView): void {
    this.#viewTurns = new Map(view.turns.map((turn) => [turn.turnId, turn.items]));
    const byTurn = new Map<string, StoredMessage[]>();
    for (const message of view.messages) byTurn.set(message.turnId, [...(byTurn.get(message.turnId) ?? []), message]);
    const statuses = new Map(view.turns.map((turn) => [turn.turnId, turn]));
    for (const item of view.items) if (item.milestone === "withdrawn") this.#report({ kind: "input_withdrawn", messageId: item.id });

    const settle = (turn: Turn, status: TurnStatus | undefined) => {
      if (!status) {
        // The harness has no such turn (a session recreated on an empty home): it cannot end by itself.
        this.#accept(turn, { type: "turn_ended", turnId: turn.harnessId, outcome: "failed", error: "the harness has no record of this turn" }, false);
        return;
      }
      for (const message of byTurn.get(status.turnId) ?? []) {
        this.#accept(turn, { type: "message_completed", turnId: status.turnId, messageId: message.messageId,
          ...(message.reference ? { reference: true as const } : { parts: message.parts }) });
      }
      // Running or checkpointed: it goes on, and its events will follow this view.
      if (status.state === "running" || status.state === "suspended") return;
      this.#accept(turn, { type: "turn_ended", turnId: status.turnId, outcome: status.state,
        ...(status.reason === undefined ? {} : { error: status.reason }),
        ...(status.uncertainCalls?.length ? { uncertainCalls: status.uncertainCalls } : {}) });
    };

    for (const turn of [...this.#turns.values()]) if (!turn.ended) settle(turn, statuses.get(turn.harnessId));
    for (const status of view.turns) {
      if (this.#turns.has(sessionTurnId(status.turnId))) continue;
      // Only a turn that owns one of this conversation's unsettled inputs: older turns were settled before.
      if (status.state !== "running" && status.turnId !== view.status?.activeTurn?.turnId && !status.items.some((id) => this.#host.records.submission(id)?.channel === this.#channel)) continue;
      settle(this.#begin(status.turnId, status.items), status);
    }
  }

  disconnected(): void { this.#notifyConnection(); }

  failed(error: Error): void {
    this.#release(error, false);
    this.#notifyConnection();
  }

  trackedTurns(): string[] {
    return [...this.#turns.values()].filter(turn => !turn.ended && !turn.released).map(turn => turn.harnessId);
  }

  busy(): boolean {
    return [...this.#turns.values()].some((turn) => !turn.ended && !turn.released);
  }

  prepareTurn(turnId: string, content: TurnContent): PreparedTurn {
    const turn = this.#turns.get(turnId);
    if (!turn || turn.released) throw new Error(`unknown turn ${turnId}`);
    const listeners = new Set<OutputListener>();
    const signal = (output: ProviderOutput) => {
      for (const listener of [...listeners]) listener(output);
      for (const listener of [...this.#outputListeners]) listener(output);
    };
    const replay = turn.ended !== null;
    return {
      turnId,
      nativeMetering: { turnId: turn.harnessId, isTerminal: () => turn.terminalOnWire === true,
        terminalEarlierTurns: terminalNativeTurns(this.#host, this.#channel), read: position =>
          (this.#usage ??= new NativeInferenceSource(this.#host.sessionId, this.#channel, this.#host.usageLedger))
            .readTurn(turn.harnessId, position) },
      recoverStoppedReplies: async seen => turn.stoppedBeforeResult ? this.#host.recoverStoppedReplies(this.#channel, turn.harnessId, seen) : undefined,
      get live() { return !replay; },
      subscribeOutput: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: () => this.#interrupt(turn),
      forceStop: () => this.forceStop(),
      prompt: () => this.#run(turn, content.handlers, signal),
    };
  }

  #run(turn: Turn, handlers: PromptHandlers, signal: (output: ProviderOutput) => void): Promise<PromptResult> {
    const sessionId = this.#host.sessionId;
    const messages: ResponseMessage[] = [];
    const drafts = new Map<string, string>();
    const approvals = new AbortController();
    const approvalWork = new Set<Promise<void>>();
    return new Promise<PromptResult>((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void, providerEnded = false) => {
        if (settled) return;
        settled = true;
        turn.sink = null;
        turn.fail = null;
        approvals.abort(providerEnded ? nativeProviderTurnEnded : undefined);
        if (turn.ended) this.#turns.delete(turn.id);
        if (approvalWork.size) void Promise.allSettled(approvalWork).then(act);
        else act();
      };
      const joined = () => messages.map(message => message.text).join("\n\n");
      const cancelled = (terminal: boolean) => finish(() => resolve({
        text: joined(), messages, stopReason: "cancelled", status: "cancelled", usage: null,
      }), terminal);
      turn.fail = (error, stopping) => {
        if (!stopping) return finish(() => reject(error));
        turn.stoppedBeforeResult = true;
        cancelled(false);
      };
      const text = (chunk: string, messageId: string, startsMessage: boolean) => {
        handlers.onChunk?.(chunk);
        handlers.onResponseChunk?.({ text: chunk, messageId, startsMessage });
      };
      const complete = (messageId: string, full: string) => {
        if (settled) return; // A by-reference read can finish after shutdown.
        const draft = drafts.get(messageId);
        // The committed text replaces a draft with the same id. Only the part not streamed is sent
        // on; a draft that diverged (dropped deltas) cannot be retracted, and the result below is
        // the committed text either way.
        if (draft === undefined) text(full, messageId, true);
        else if (full.startsWith(draft) && full.length > draft.length) text(full.slice(draft.length), messageId, false);
        drafts.delete(messageId);
        if (!messages.some((message) => message.messageId === messageId)) messages.push({ messageId, text: full });
        signal({ kind: "update", sessionId });
      };
      // Events are applied one at a time, in order: a message fetched by reference must not be
      // overtaken by the events behind it.
      let chain: Promise<void> = Promise.resolve();
      const apply = async (event: TurnScoped, attachment: AbortSignal): Promise<void> => {
        switch (event.type) {
          case "text_delta":
            text(event.text, event.messageId, !drafts.has(event.messageId));
            drafts.set(event.messageId, (drafts.get(event.messageId) ?? "") + event.text);
            signal({ kind: "update", sessionId });
            return;
          case "text_gap":
          case "text_incomplete":
            return; // a draft is provisional: only a completion with its id makes it a reply
          case "message_completed": {
            const messageId = event.messageId!;
            complete(messageId, event.reference ? await this.#host.readMessage(messageId) : (event.parts ?? []).map((part) => part.text).join(""));
            return;
          }
          case "tool_call": {
            const activity = event.status === "started"
              ? { kind: "tool" as const, toolCallId: event.id, title: event.name, toolKind: "other", status: "in_progress", ...(event.input === undefined ? {} : { rawInput: parse(event.input) }) }
              // A call that was skipped, or whose wait ended without an outcome, did not complete.
              : { kind: "tool_update" as const, toolCallId: event.id, status: event.status === "completed" ? "completed" : "failed", ...(event.output === undefined ? {} : { rawOutput: event.output }) };
            handlers.onActivity?.(activity);
            signal({ kind: "update", sessionId, activity });
            return;
          }
          case "approval_requested":
            // Not awaited: the turn can end (interrupted, timed out) while the consumer decides, and
            // that end must not wait behind the question.
            if (turn.approvals.has(event.requestId)) return;
            turn.approvals.add(event.requestId);
            const approval = this.#approve(event, handlers,
              AbortSignal.any([approvals.signal, attachment]), signal);
            if (recordingPermissionHandlers.has(handlers.onPermissionRequest!)) {
              approvalWork.add(approval);
              void approval.then(() => approvalWork.delete(approval));
            }
            return;
          case "turn_resumed":
            signal({ kind: "update", sessionId });
            return;
          case "turn_ended": {
            if (event.outcome === "completed") {
              finish(() => resolve({ text: joined(), messages, stopReason: "end_turn", status: "completed", usage: null }), true);
            } else if (event.outcome === "interrupted" && turn.cancelRequested) {
              cancelled(true);
            } else {
              const reason = event.error ?? event.outcome;
              finish(() => reject(new NativeTurnError(event.outcome as "failed" | "interrupted", `native turn ${turn.harnessId} ${event.outcome}: ${reason}`, event.uncertainCalls)), true);
            }
            return;
          }
          default:
            return; // receipts and checkpoints change nothing the handlers show
        }
      };
      turn.sink = (event) => {
        const attachment = this.#attachmentApprovals.signal;
        chain = chain.then(() => (settled ? undefined : apply(event, attachment))).catch((error) => {
          this.#log.warn("native_turn_event_failed", { turnId: turn.id, type: event.type, error: String(error) });
          // A reply that cannot be read is a failed turn for the host, never a silently shorter one.
          if (event.type === "message_completed") finish(() => reject(error));
        });
      };
      const held = turn.held;
      turn.held = [];
      for (const event of held) turn.sink(event);
    });
  }

  async #approve(event: Extract<TurnScoped, { type: "approval_requested" }>, handlers: PromptHandlers, cancelled: AbortSignal, signal: (output: ProviderOutput) => void): Promise<void> {
    const ticket = this.#host.approvalFor(event);
    if (!ticket) return;
    const sessionId = this.#host.sessionId;
    signal({ kind: "permission_started", sessionId });
    try { await runNativeApproval(ticket, event, handlers, cancelled, this.#log); }
    finally { signal({ kind: "permission_ended", sessionId }); }
  }

  #interrupt(turn: Turn): void {
    if (turn.ended) return;
    turn.cancelRequested = true;
    this.#host.interrupt(this.#channel, turn.harnessId, "interrupted by the conversation").catch((error) => {
      // Not running: the reopen's view will report the turn interrupted, and it settles as cancelled.
      this.#log.debug("native_interrupt_not_sent", { turnId: turn.id, error: String(error) });
    });
  }

  /**
   * Ends a reported turn the session will not run: releases what is held for it. Idempotent, and never
   * stops the harness's work (that is `cancel` / `forceStop`); a turn already executing is left alone.
   */
  abandonTurn(turnId: string, _reason: unknown): void {
    const turn = this.#turns.get(turnId);
    if (!turn || turn.released || turn.sink) return;
    turn.released = true;
    this.#refuseHeldApprovals(turn);
    turn.held = [];
    if (turn.ended) this.#turns.delete(turnId);
  }

  subscribeOutput(listener: OutputListener): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  /** Cancels the turn executing now on this channel. Other channels are untouched. */
  cancel(): void {
    for (const turn of this.#turns.values()) if (!turn.ended && !turn.released) this.#interrupt(turn);
  }

  /**
   * Conversation-level force stop: a targeted interrupt of this channel's active turn, and this
   * conversation's own work settled locally (open prepared turns reject). The shared process, its
   * other channels and their subscriptions are untouched: only the host stops the process.
   */
  async forceStop(): Promise<void> {
    this.#release(new Error("forced stop"), true);
  }

  #release(error: Error, interrupt: boolean, stopping = false): void {
    for (const turn of [...this.#turns.values()]) {
      turn.released = true;
      this.#refuseHeldApprovals(turn);
      turn.held = [];
      turn.fail?.(error, stopping);
      if (interrupt && !turn.ended) this.#interrupt(turn);
      if (turn.ended) this.#turns.delete(turn.id);
    }
  }
}

function parse(input: string): unknown {
  try { return JSON.parse(input); } catch { return input; }
}
