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
  readonly tools: Map<string, string>;
  endedBy?: PromptEndedBy;
}

const TERMINAL = new Set(["completed", "failed"]);

/** A prompt the consumer started and that steering may cancel. Hidden or internal turns are not. */
function isConsumerPrompt<T extends { readonly kind: string }>(item: T): item is T & SteeringPrompt {
  return item.kind === "prompt" && (item as unknown as SteeringPrompt).operationKind === "prompt";
}

/**
 * Messages that wait while a turn runs.
 *
 * There is one FIFO (the conversation's operations queue). This class adds a delivery mode to the
 * prompts in it, watches the running turn for a tool boundary, and sends the head of the queue by
 * cancelling the turn. It never reorders the queue and never cancels anything but a consumer prompt.
 */
export class SteeringController<T extends { readonly kind: string }> {
  #active: ActiveTurn | null = null;
  /** How the previous turn ended, for the `via` of the next delivery. */
  #previousEndedBy: PromptEndedBy | null = null;

  constructor(
    private readonly host: SteeringHost<T>,
    readonly defaultDelivery: PromptDelivery,
  ) {}

  resolveDelivery(requested: PromptDelivery | undefined): PromptDelivery {
    return requested ?? this.defaultDelivery;
  }

  /** The mode in effect for a message accepted now. */
  effectiveDelivery(requested: PromptDelivery): PromptDelivery {
    return this.#active ? requested : "queue";
  }

  /** Called when a prompt has been queued. Only prompts that had to wait are reported. */
  accepted(item: SteeringPrompt): void {
    if (!item.waited) return;
    this.host.emit({
      kind: "message_pending",
      id: item.turnId,
      delivery: this.effectiveDelivery(item.delivery),
    });
  }

  // --- the running turn --------------------------------------------------------------------

  turnStarted(item: SteeringPrompt): void {
    this.#active = item.operationKind === "prompt" ? { turnId: item.turnId, tools: new Map() } : null;
  }

  /** Activity of the running turn. A tool call settling is where a steer message is delivered. */
  observeActivity(turnId: string, event: ActivityEvent): void {
    const active = this.#active;
    if (!active || active.turnId !== turnId) return;
    if (event.kind !== "tool" && event.kind !== "tool_update") return;
    const previous = active.tools.get(event.toolCallId);
    const status = event.status ?? previous ?? "pending";
    active.tools.set(event.toolCallId, status);
    const settled = TERMINAL.has(status) && !(previous !== undefined && TERMINAL.has(previous));
    if (!settled) return;
    const inFlight = [...active.tools.values()].some((value) => !TERMINAL.has(value));
    if (!inFlight) this.#boundary(active);
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

  /** The turn finished. `endedBy` is reported only if the provider really stopped the turn. */
  turnEnded(stopReason: string | undefined): void {
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
   * sent as one prompt; anything else is sent as it is.
   */
  prepareRun(head: SteeringPrompt): SteeringPrompt {
    const run = head.operationKind === "prompt" && head.delivery === "steer"
      ? [head, ...(this.host.queue.takeWhile((item) => isConsumerPrompt(item) && item.delivery === "steer") as unknown as SteeringPrompt[])]
      : [head];
    const waited = run.filter((item) => item.waited);
    if (waited.length > 0) {
      this.host.emit({
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
    return this.#previousEndedBy === "steer"
      ? "tool_boundary"
      : this.#previousEndedBy === "interrupt"
        ? "interrupt"
        : "turn_end";
  }

  #headRun(): SteeringPrompt[] {
    const run: SteeringPrompt[] = [];
    for (const item of this.host.queue.snapshot()) {
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
