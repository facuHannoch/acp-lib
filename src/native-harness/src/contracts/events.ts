/** Loop facts; composition supplies channel/turn IDs and message IDs. */
export type LoopEvent =
  | { type: "message_completed"; parts: { type: "text"; text: string }[] }
  | { type: "tool_call"; id: string; name: string; status: "started" | "completed" | "failed"; input?: string; output?: string };

/** Ordered within a channel; no order is promised across channels. */
export interface ChannelEvent {
  channel: string;
  event: (LoopEvent & { turnId: string; messageId?: string })
    | { type: "turn_started" | "turn_took"; turnId: string; items: string[] }
    | { type: "turn_ended"; turnId: string; outcome: "completed" | "failed"; error?: string };
}
export type EventSink = (event: ChannelEvent) => void;
