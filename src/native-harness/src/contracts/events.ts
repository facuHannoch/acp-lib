/** Loop facts; composition supplies channel/turn IDs and message IDs. */
export type LoopEvent =
  | ({ type: "message_completed" } & ({ parts: { type: "text"; text: string }[]; reference?: never } | { parts?: never; reference: true }))
  | { type: "tool_call"; id: string; name: string; status: "started" | "completed" | "failed"; input?: string; output?: string };

/** Ordered within a channel; no order is promised across channels.
 * With storage (decision 0013) every event except tool_call started/failed
 * reports a committed record and is published only after that commit:
 * - `revision` is the storage revision containing it. Event revisions never
 *   decrease on one subscription.
 * - `turn_started`/`turn_took` list the item IDs that commit took into `turnId`.
 *   This is how an accepted input is correlated to its turn; several IDs,
 *   across one or more of these events, may name the same turn.
 * - `items_receipt` reports Delivered/Seen for items of that turn, and is
 *   published only after a commit that advanced at least one milestone.
 * - `message_completed.messageId` is the stable timeline ID of the message.
 * - `turn_suspended` is a checkpoint, not an end (session or channel suspension);
 *   `turn_resumed` continues it under the same turn ID.
 * - `channel_state` reports a committed change of the channel record: create,
 *   edit, suspension begun or completed, resume, retirement. It carries the
 *   resulting lifecycle and name, and no turn ID.
 * - `item_withdrawn` reports a committed withdrawal of a pending item.
 * - `turn_ended` is terminal for the turn only. `interrupted` and `failed` may
 *   list `uncertainCalls`, which are never replayed. The channel stays usable.
 * Events are live notifications, not a durable replay log. */
export interface ChannelEvent {
  channel: string;
  revision?: number;
  event: (LoopEvent & { turnId: string; messageId?: string })
    | import("./model-execution.ts").ModelTextEvent
    | { type: "turn_started" | "turn_took"; turnId: string; items: string[] }
    | { type: "items_receipt"; turnId: string; items: string[]; milestone: "delivered" | "seen" }
    | { type: "turn_suspended" | "turn_resumed"; turnId: string }
    | { type: "channel_state"; lifecycle: "open" | "suspending" | "suspended" | "retired"; displayName?: string; policy?: string }
    | { type: "item_withdrawn"; item: string }
    | ({ type: "approval_requested" } & import("./config-permissions.ts").ApprovalRequest)
    | { type: "turn_ended"; turnId: string; outcome: "completed" | "failed" | "interrupted"; error?: string; uncertainCalls?: string[] };
}
export type EventSink = (event: ChannelEvent) => void;

/** Published after the lifecycle transition commits. */
export interface SessionEvent { type: "lifecycle"; lifecycle: "running" | "suspending" | "suspended"; revision: number }
export type SessionEventSink = (event: SessionEvent) => void;
