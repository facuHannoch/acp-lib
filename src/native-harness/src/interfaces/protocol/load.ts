import type { ItemStatus, LoadResult, StatusResult, StoredMessage, TurnStatus } from "../../contracts/protocol.ts";
import type { SessionStatus } from "../../contracts/session.ts";
import type { StorageSnapshot, StoredTurn } from "../../contracts/storage.ts";
import { MAX_FRAME_BYTES } from "./framing.ts";

/** Room left in a frame for the JSON-RPC envelope around a result. */
const BUDGET = MAX_FRAME_BYTES - 1024;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export class FrameLimit extends Error {}

export function turnStatus(turn: StoredTurn): TurnStatus {
  const state = turn.state;
  return { turnId: String(turn.turnId), channel: turn.channelId, items: turn.itemIds, state: state.status,
    ...(state.status === "failed" || state.status === "interrupted" ? { reason: state.reason, uncertainCalls: state.uncertainCallIds } : {}) };
}

export function wireStatus(status: SessionStatus, view: StorageSnapshot): StatusResult {
  return { sessionId: status.sessionId, revision: status.revision, lifecycle: status.lifecycle, execution: status.execution,
    channels: status.channels.map(channel => {
      const unresolved = channel.unresolvedInterruption && view.turns.find(turn => turn.turnId === channel.unresolvedInterruption!.turnId);
      return { channel: channel.channelId, pending: channel.pendingItemIds, lifecycle: channel.lifecycle, waitingForResume: channel.waitingForResume,
        ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
        ...(channel.policy === undefined ? {} : { policy: channel.policy }),
        ...(channel.activeTurn ? { activeTurn: { turnId: String(channel.activeTurn.turnId), state: channel.activeTurn.status } } : {}),
        ...(unresolved ? { unresolved: turnStatus(unresolved) } : {}) };
    }) };
}

/** Committed assistant text after `after`, no newer than `revision`, filled
 * until the count or the frame budget is reached. A page whose own records fit
 * is complete, whatever follows it. Only a request whose first record cannot
 * fit a frame by itself fails: that record is never skipped or truncated. */
export function pageMessages(view: StorageSnapshot, revision: number, after: number, limit: number, used = 0) {
  const messages: StoredMessage[] = [];
  let nextMessage: string | undefined;
  for (const entry of view.timeline) {
    if (entry.seq <= after || entry.seq > revision || entry.message.role !== "assistant" || !entry.message.content) continue;
    const message: StoredMessage = { messageId: entry.messageId ?? String(entry.seq), channel: entry.channelId, turnId: String(entry.turnId),
      parts: [{ type: "text", text: entry.message.content }] };
    if (size(message) + 1 > BUDGET) { delete (message as { parts?: unknown }).parts; Object.assign(message, { reference: true }); }
    const bytes = size(message) + 1;
    // Count reached, or no room left on this page: an ordinary page break.
    if (messages.length >= limit || used + bytes > BUDGET) { nextMessage = messages.at(-1)?.messageId ?? String(after); break; }
    messages.push(message); used += bytes;
  }
  return { messages, ...(nextMessage === undefined ? {} : { nextMessage }) };
}

/** One view of one snapshot. Turns and items are not paged, so they must fit. */
export function loadView(status: SessionStatus, view: StorageSnapshot, limit: number): LoadResult {
  const fixed = {
    status: wireStatus(status, view), turns: view.turns.map(turnStatus),
    items: view.items.map((item): ItemStatus => ({ id: item.itemId, channel: item.channelId, kind: item.kind, sender: item.senderId,
      milestone: item.milestone, ...(item.policy === undefined ? {} : { policy: item.policy }), ...(item.turnId === undefined ? {} : { turnId: String(item.turnId) }) })),
  };
  const used = size(fixed);
  if (used > BUDGET) throw new FrameLimit("Session turns and items do not fit in one protocol frame");
  return { ...fixed, ...pageMessages(view, view.revision, 0, limit, used) };
}
