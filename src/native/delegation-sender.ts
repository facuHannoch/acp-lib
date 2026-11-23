import type { HarnessClient } from "../native-harness/src/client.ts";
import { FunctionError } from "./functions.ts";

/** Use the first taken input as the caller's attribution, even if more inputs arrive during the turn. */
export async function takenSender(
  client: Pick<HarnessClient, "reconcileChannel">, channel: string, turnId: string, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const tracked = await client.reconcileChannel({ channel, turnIds: [turnId] });
  signal.throwIfAborted();
  const turn = tracked.turns.find(value => value.turnId === turnId && value.channel === channel);
  const first = turn?.state === "running" ? turn.items[0] : undefined;
  if (!first) throw new FunctionError("delegation_sender_unavailable", "No taken input identifies this delegation call");
  const { items } = await client.reconcileChannel({ channel, itemIds: [first] });
  signal.throwIfAborted();
  const item = items.find(value => value.id === first && value.channel === channel && value.turnId === turnId);
  const id = item?.sender.trim();
  if (!item || !id) throw new FunctionError("delegation_sender_unavailable", "No sender identifies the turn's first taken input");
  if (item.kind !== "participant_message") return `notice:${id}`;
  if (/^[\s\p{Default_Ignorable_Code_Point}]+$/u.test(id)) {
    throw new FunctionError("delegation_sender_unavailable", "Blank participant ID");
  }
  // Escape reserved prefixes so arbitrary participant IDs stay distinct from notice labels.
  if (id.startsWith("notice:") || id.startsWith("participant:")) return `participant:${id}`;
  return id;
}
