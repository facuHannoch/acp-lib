// One status per user message, the same for every conversation: how far a message has got, from
// accepted to seen by the model. Built from events the session already has (spec:
// .res/somelogs.md/11-11+/11-24-SPEC-message-status.md); it adds no new evidence.
//
// Native conversations read the harness's milestones (push accepted, turn take, `items_receipt`).
// ACP conversations approximate: `taken` and `delivered` when the prompt is sent, `seen` at the
// provider's first output.

/** Forward steps, in order, then the two end states. */
export type MessageStatus = "queued" | "received" | "taken" | "delivered" | "seen" | "withdrawn" | "failed";

/** The conversation event reporting a message's new status. */
export interface MessageStatusEvent {
  readonly kind: "message_status";
  readonly id: string;
  readonly status: MessageStatus;
  readonly turnId?: string;
}

const FORWARD: readonly MessageStatus[] = ["queued", "received", "taken", "delivered", "seen"];

/**
 * Tracks the conversation's own messages. Statuses only move forward; skipped steps are reported in
 * order, so every backend shows the same sequence. Ids it never tracked (external notices in a native
 * receipt) are ignored. Entries outlive the prompt's settlement, so a handle can still be read.
 */
export class MessageStatusTracker {
  readonly #status = new Map<string, MessageStatus>();
  readonly #turnOf = new Map<string, string>();
  readonly #idsOfTurn = new Map<string, Set<string>>();

  constructor(private readonly emit: (event: MessageStatusEvent) => void) {}

  statusOf(id: string): MessageStatus | undefined {
    return this.#status.get(id);
  }

  /** A message the conversation accepted. */
  accept(id: string): void {
    if (this.#status.has(id)) return;
    this.#status.set(id, "queued");
    this.emit({ kind: "message_status", id, status: "queued" });
  }

  /** The ids a turn carries, so a later turn-level signal (ACP first output) reaches each of them. */
  link(turnId: string, ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.#status.has(id)) continue;
      this.#turnOf.set(id, turnId);
      let set = this.#idsOfTurn.get(turnId);
      if (!set) this.#idsOfTurn.set(turnId, set = new Set());
      set.add(id);
    }
  }

  idsOfTurn(turnId: string): readonly string[] {
    return [...(this.#idsOfTurn.get(turnId) ?? [])];
  }

  /** Move forward to `status`, reporting each skipped step. No effect backwards or after an end state. */
  advance(id: string, status: Exclude<MessageStatus, "withdrawn" | "failed">): void {
    const current = this.#status.get(id);
    if (current === undefined || current === "withdrawn" || current === "failed") return;
    const from = FORWARD.indexOf(current);
    const to = FORWARD.indexOf(status);
    for (let step = from + 1; step <= to; step++) this.#set(id, FORWARD[step]!);
  }

  /** End states. `failed` only before `seen`: once seen, the prompt's result says how the turn ended. */
  end(id: string, status: "withdrawn" | "failed"): void {
    const current = this.#status.get(id);
    if (current === undefined || current === "withdrawn" || current === "failed" || current === "seen") return;
    // Withdrawal is possible only before a turn took the message.
    if (status === "withdrawn" && FORWARD.indexOf(current) >= FORWARD.indexOf("taken")) return;
    this.#set(id, status);
  }

  #set(id: string, status: MessageStatus): void {
    this.#status.set(id, status);
    const turnId = this.#turnOf.get(id);
    this.emit({ kind: "message_status", id, status, ...(turnId ? { turnId } : {}) });
  }
}
