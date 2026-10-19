import type { ActivityEvent } from "../../types.ts";
import { RECAP_INSTRUCTION } from "./recap.ts";
import { extractResponseChunk, toActivityEvent } from "../../updates.ts";

/** One piece of an imported turn, in the order the provider replayed it. */
export type ImportedItem =
  | { readonly kind: "user"; text: string; readonly messageId?: string }
  | { readonly kind: "assistant"; text: string; readonly messageId?: string }
  | { readonly kind: "activity"; readonly event: ActivityEvent };

/** A turn of replayed history. It starts at a user message, except possibly the first. */
export interface ImportedTurn {
  readonly items: ImportedItem[];
}

/** Activity worth storing. Command lists, mode, config, usage and session-info updates are not history. */
const STORED_ACTIVITY = new Set(["thinking", "tool", "tool_update", "plan", "plan_update", "plan_removed"]);

/**
 * Turn the raw `session/update` notifications of a `session/load` replay into turns.
 *
 * A replay has no turn markers. Message boundaries are the provider's `messageId` where it gives one (both
 * Codex and OpenCode do), and a turn starts at each user message. Tool calls are kept in the position the
 * replay gives them: a harness may place the tool call of a turn that was cancelled mid-tool after the next
 * turn's user message, and that is carried over as it arrives.
 */
export function turnsFromReplay(notifications: readonly unknown[]): ImportedTurn[] {
  const turns: ImportedTurn[] = [];
  let current: ImportedTurn | null = null;
  const lastItem = (): ImportedItem | undefined => current?.items.at(-1);

  for (const notification of notifications) {
    const update = (notification as { update?: Record<string, unknown> } | null)?.update;
    if (!update || typeof update.sessionUpdate !== "string") continue;

    const response = extractResponseChunk(update as never);
    if (response) {
      if (!current) {
        current = { items: [] };
        turns.push(current);
      }
      const last = lastItem();
      if (last?.kind === "assistant" && last.messageId === response.messageId) {
        last.text += response.text;
      } else {
        current.items.push({
          kind: "assistant",
          text: response.text,
          ...(response.messageId !== undefined ? { messageId: response.messageId } : {}),
        });
      }
      continue;
    }

    const event = toActivityEvent(update as never);
    if (!event) continue;
    if (event.kind === "user_message") {
      const last = lastItem();
      if (last?.kind === "user" && last.messageId === event.messageId) {
        last.text += event.text;
        continue;
      }
      current = { items: [] };
      turns.push(current);
      current.items.push({
        kind: "user",
        text: event.text,
        ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
      });
      continue;
    }
    if (!STORED_ACTIVITY.has(event.kind)) continue;
    if (!current) {
      current = { items: [] };
      turns.push(current);
    }
    current.items.push({ kind: "activity", event });
  }
  return turns;
}

/** The last `n` turns, or all of them. */
export function selectTail(turns: readonly ImportedTurn[], last: number | undefined): ImportedTurn[] {
  return last === undefined ? [...turns] : turns.slice(-last);
}

/**
 * Drop the turns that are an earlier adoption's recap: the question is a turn of the provider's own history
 * once it has been asked, so a later adoption of the same session replays it. It is not something the
 * participants said, and the answer is the recap, which this adoption makes (or does not) for itself.
 */
export function withoutRecapTurns(turns: readonly ImportedTurn[]): ImportedTurn[] {
  const question = RECAP_INSTRUCTION.trim();
  return turns.filter((turn) => {
    const first = turn.items.find((item) => item.kind === "user");
    return !(first && first.text.trim() === question);
  });
}
