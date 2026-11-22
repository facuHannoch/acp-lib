import type { HarnessClient, ItemStatus, StoredMessage, TurnStatus } from "../native-harness/src/client.ts";

export async function recoverChannel(
  client: HarnessClient, channel: string, itemIds: readonly string[], trackedTurns: readonly string[], options: { signal?: AbortSignal; atObservation?: () => void } = {},
) {
  const { signal, atObservation } = options;
  const observation = await client.observeChannel({ channel });
  signal?.throwIfAborted();
  atObservation?.();
  const items: ItemStatus[] = [], turns: TurnStatus[] = [], messages: StoredMessage[] = [];
  const tracked = new Set(trackedTurns);
  if (observation.channel.activeTurn) tracked.add(observation.channel.activeTurn.turnId);
  for (let offset = 0; offset < itemIds.length; offset += 100) {
    const page = await client.reconcileChannel({ channel, itemIds: itemIds.slice(offset, offset + 100) });
    signal?.throwIfAborted();
    items.push(...page.items);
    for (const item of page.items) if (item.turnId) tracked.add(item.turnId);
  }
  const turnIds = [...tracked];
  for (let offset = 0; offset < turnIds.length; offset += 100) {
    let page = await client.reconcileChannel({ channel, turnIds: turnIds.slice(offset, offset + 100) });
    signal?.throwIfAborted();
    turns.push(...page.turns);
    while (true) {
      messages.push(...page.replies.map(reply => ({ channel, messageId: reply.messageId, turnId: reply.turnId, reference: true as const })));
      if (!page.next) break;
      page = await client.reconcileChannel({ channel, cursor: page.next });
      signal?.throwIfAborted();
    }
  }
  return { observation, items, turns, messages };
}
