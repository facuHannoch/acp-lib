import { ToolTracker } from "../operations/activity-tracker.ts";
import type { AgentSessionPromptResult } from "../agent-conversation-contracts.ts";
import type { AgentConversationQueue } from "../agent-conversation-queue.ts";
import type { ActivityEvent } from "../types.ts";
import { combinePrompts } from "./combine.ts";
import type {
  MessageDeliveryVia,
  MessageEvent,
  PendingMessage,
  PendingMessageId,
  PromptDelivery,
  PromptEndedBy,
  SteeringPrompt,
} from "./contracts.ts";

/** What the controller needs from the conversation that owns it. */
export interface SteeringHost<T extends { readonly kind: string }> {
  readonly queue: AgentConversationQueue<T>;
  emit(event: MessageEvent): void;
  /** Cancel the running provider turn. It must not touch the queue. */
  cancelProviderTurn(): void;
  /** Re-publish the conversation state (the queued count changed). */
  emitState(): void;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly tools: ToolTracker;
  endedBy?: PromptEndedBy;
}


/** A prompt the consumer started and that steering may cancel. Hidden or internal turns are not. */
function isConsumerPrompt<T extends { readonly kind: string }>(item: T): item is T & SteeringPrompt {
  return item.kind === "prompt" && (item as unknown as SteeringPrompt).operationKind === "prompt";
}

/**
 * Messages that wait while a turn runs.
 *
 * There is one FIFO (the conversation's operations queue). This class adds a delivery mode to the
 * prompts in it, watches the running turn for a tool boundary, and sends the head of the queue by
 * cancelling the turn. It skips held queue messages after failures and only cancels consumer prompts.
 */
export class SteeringController<T extends { readonly kind: string }> {
  #active: ActiveTurn | null = null;
  #heldBy: string | null = null;
  /** How the previous turn ended, for the `via` of the next delivery. */
  #previousEndedBy: PromptEndedBy | null = null;
  /** Where `takeNext()` took the last item from: the items after it in the FIFO start there. */
  #takenAt = 0;

  constructor(
    private readonly host: SteeringHost<T>,
    readonly defaultDelivery: PromptDelivery,
  ) {}

  get hold(): { readonly failedTurnId: string } | null { return this.#heldBy ? Object.freeze({ failedTurnId: this.#heldBy }) : null; }
  #eligible(item: T): boolean { return !this.#heldBy || !isConsumerPrompt(item) || item.delivery !== "queue"; }
  get hasRunnable(): boolean { return this.host.queue.snapshot().some((item) => this.#eligible(item)); }
  takeNext(): T | undefined {
    this.#takenAt = this.host.queue.snapshot().findIndex((item) => this.#eligible(item));
    return this.host.queue.remove((item) => this.#eligible(item));
  }
  followingSteers(): readonly string[] { return this.#headRun().map((item) => item.turnId); }
  /**
   * A turn the provider received ended `stalled` or `error`: every happy-path queued message is held,
   * and steers may repair the turn. A prompt that failed before reaching the provider calls
   * `turnEnded(undefined)` instead and holds nothing.
   */
  failed(turnId: string, reason: "stalled" | "error"): void {
    this.#previousEndedBy = reason;
    this.#heldBy = turnId;
    for (const item of this.host.queue.snapshot()) {
      if (isConsumerPrompt(item) && item.delivery === "queue") this.host.emit({ kind: "message_held", id: item.turnId, failedTurnId: turnId });
    }
    this.#active = null;
    this.host.emitState();
  }
  #release(): void {
    const failedTurnId = this.#heldBy;
    if (!failedTurnId) return;
    this.#heldBy = null;
    for (const item of this.host.queue.snapshot()) {
      if (isConsumerPrompt(item) && item.delivery === "queue") this.host.emit({ kind: "message_released", id: item.turnId, failedTurnId });
    }
    this.host.emitState();
  }

  resolveDelivery(requested: PromptDelivery | undefined): PromptDelivery {
    return requested ?? this.defaultDelivery;
  }

  /** The mode in effect for a message accepted now. */
  effectiveDelivery(requested: PromptDelivery): PromptDelivery {
    return this.#active || this.#heldBy ? requested : "queue";
  }

  /** Called when a prompt has been queued. Only prompts that had to wait are reported. */
  accepted(item: SteeringPrompt): void {
    if (this.#heldBy && item.delivery === "queue") this.host.emit({ kind: "message_held", id: item.turnId, failedTurnId: this.#heldBy });
    if (!item.waited) return;
    this.host.emit({
      kind: "message_pending",
      id: item.turnId,
      delivery: this.effectiveDelivery(item.delivery),
    });
  }

  // --- the running turn --------------------------------------------------------------------

  turnStarted(item: SteeringPrompt): void {
    this.#active = item.operationKind === "prompt" ? { turnId: item.turnId, tools: new ToolTracker() } : null;
  }

  /** Activity of the running turn. A tool call settling is where a steer message is delivered. */
  observeActivity(turnId: string, event: ActivityEvent): void {
    const active = this.#active;
    if (!active || active.turnId !== turnId) return;
    if (event.kind !== "tool" && event.kind !== "tool_update") return;
    const settled = active.tools.observe(event);
    if (settled && active.tools.inFlight === 0) this.#boundary(active);
  }

  toolBoundary(turnId: string): void {
    if (this.#active?.turnId === turnId) this.#boundary(this.#active);
  }

  /** A tool call has settled and nothing else is running: send the head of the queue if it steers. */
  #boundary(active: ActiveTurn): void {
    if (active.endedBy) return;
    const head = this.host.queue.peek();
    if (!head || !isConsumerPrompt(head) || head.delivery !== "steer") return;
    active.endedBy = "steer";
    this.host.cancelProviderTurn();
  }

  /** The consumer called `interrupt()`. */
  interrupted(): void {
    if (this.#active && !this.#active.endedBy) this.#active.endedBy = "interrupt";
  }

  /**
   * The turn finished. `endedBy` is reported only if the provider really stopped the turn. Only a
   * consumer turn that completes releases a hold; internal prompts do not.
   */
  turnEnded(stopReason: string | undefined): void {
    if (stopReason === "stalled" || stopReason === "error") return;
    if (this.#active && stopReason && stopReason !== "cancelled") this.#release();
    const endedBy = this.#active?.endedBy;
    this.#previousEndedBy = endedBy && stopReason === "cancelled" ? endedBy : null;
    this.#active = null;
  }

  /** Extra fields of the result of a turn that was cancelled by steering or by `interrupt()`. */
  resultFields(turnId: string, stopReason: string): { endedBy?: PromptEndedBy; followedBy?: readonly PendingMessageId[] } {
    const endedBy = this.#active?.turnId === turnId ? this.#active.endedBy : undefined;
    if (!endedBy || stopReason !== "cancelled") return {};
    const followedBy = this.#headRun().map((item) => item.turnId);
    return { endedBy, ...(followedBy.length > 0 ? { followedBy } : {}) };
  }

  // --- delivery ----------------------------------------------------------------------------

  /**
   * Called when a prompt reaches the head of the queue. A run of consecutive `steer` messages is
   * sent as one prompt; anything else is sent as it is. The run stops at the next queued message,
   * held or not: steers sent after it run after it.
   */
  prepareRun(head: SteeringPrompt, deliver: (event: MessageEvent) => void = (event) => this.host.emit(event)): SteeringPrompt {
    const run = [head];
    if (head.operationKind === "prompt" && head.delivery === "steer") {
      for (;;) {
        const next = this.host.queue.snapshot()[this.#takenAt];
        if (!next || !isConsumerPrompt(next) || next.delivery !== "steer") break;
        run.push(this.host.queue.remove((item) => item === next) as unknown as SteeringPrompt);
      }
    }
    const waited = run.filter((item) => item.waited);
    if (waited.length > 0) {
      deliver({
        kind: "message_delivered",
        ids: waited.map((item) => item.turnId),
        via: this.#via(),
        turnId: head.turnId,
      });
    }
    this.#previousEndedBy = null;
    if (run.length > 1) this.host.emitState();
    return combinePrompts(run);
  }

  #via(): MessageDeliveryVia {
    return this.#previousEndedBy === "stalled" ? "stall" : this.#previousEndedBy === "steer"
      ? "tool_boundary"
      : this.#previousEndedBy === "interrupt"
        ? "interrupt"
        : "turn_end";
  }

  /** The steers the next delivery would combine: from the first runnable item up to the next queued message. */
  #headRun(): SteeringPrompt[] {
    const queued = this.host.queue.snapshot();
    const run: SteeringPrompt[] = [];
    for (const item of queued.slice(Math.max(0, queued.findIndex((item) => this.#eligible(item))))) {
      if (!isConsumerPrompt(item) || item.delivery !== "steer") break;
      run.push(item);
    }
    return run;
  }

  // --- the queue ---------------------------------------------------------------------------

  /** What waits in the queue, in order. */
  pending(): readonly PendingMessage[] {
    return this.host.queue.snapshot().filter(isConsumerPrompt).map((item) => ({
      id: item.turnId,
      delivery: item.delivery,
      ...(this.#heldBy && item.delivery === "queue" ? { heldBy: this.#heldBy } : {}),
      ...(item.participantId ? { participantId: item.participantId } : {}),
      text: item.text,
    }));
  }

  /** Take back a message that has not been delivered. Its promise settles as a cancelled prompt. */
  withdraw(id: PendingMessageId): boolean {
    const item = this.host.queue.remove((candidate) => isConsumerPrompt(candidate) && candidate.turnId === id);
    if (!item) return false;
    this.dropped([item as unknown as SteeringPrompt]);
    this.host.emitState();
    return true;
  }

  /** Settle prompts that left the queue without running (withdrawn, or dropped by `interrupt`). */
  dropped(items: readonly SteeringPrompt[]): void {
    for (const item of items) {
      item.resolve(cancelledPromptResult(item));
      if (item.waited) this.host.emit({ kind: "message_withdrawn", id: item.turnId });
    }
  }
}

/** The result of a prompt that never reached the provider: nothing was sent, so nothing was consumed. */
export function cancelledPromptResult(item: { readonly turnId: string }): AgentSessionPromptResult {
  return {
    text: "",
    messages: Object.freeze([]),
    stopReason: "cancelled",
    status: "cancelled",
    usage: null,
    operationId: item.turnId,
    metering: null,
  };
}
