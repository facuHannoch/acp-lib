import type { HarnessClient, LoadResult, StoredMessage } from "../../src/client.ts";

/** Test-only reconstruction for fixtures which assert on several independent
 * views. Production open leaves history fetching to the consumer. */
export async function inspectOperatorView(client: HarnessClient, params: Parameters<HarnessClient["openSession"]>[0]): Promise<LoadResult> {
  const opened = await client.openSession(params);
  const status = await client.status();
  const items: LoadResult["items"] = [], turns: LoadResult["turns"] = [];
  const takenOrder = new Map<string, number>();
  const messages: { message: StoredMessage; seq: number }[] = [];
  for (const channel of status.channels) {
    const itemIds = new Set(channel.pending), turnIds = new Set<string>();
    if (channel.activeTurn) turnIds.add(channel.activeTurn.turnId);
    if (channel.unresolved) turnIds.add(channel.unresolved.turnId);
    let cursor: string | undefined;
    do {
      const page = await client.channelMessages(cursor ? { channel: channel.channel, cursor } : { channel: channel.channel });
      for (const message of page.messages) {
        turnIds.add(message.turnId);
        if (message.itemId) {
          itemIds.add(message.itemId);
          const [, , seq] = JSON.parse(Buffer.from(message.position, "base64url").toString()) as [string, string, number];
          takenOrder.set(message.itemId, seq);
        }
        else if (!("omitted" in message)) {
          const { position, actor: _actor, ...wire } = message;
          const [, , seq] = JSON.parse(Buffer.from(position, "base64url").toString()) as [string, string, number];
          messages.push({ message: wire, seq });
        }
      }
      cursor = page.next;
    } while (cursor);
    const tracked = await client.reconcileChannel({ channel: channel.channel, itemIds: [...itemIds], turnIds: [...turnIds] });
    items.push(...tracked.items);
    turns.push(...tracked.turns.map(turn => ({ ...turn, items: tracked.items.filter(item => item.turnId === turn.turnId).sort((a, b) => (takenOrder.get(a.id) ?? Infinity) - (takenOrder.get(b.id) ?? Infinity)).map(item => item.id) })));
  }
  const linked = new Map(turns.map(turn => [turn.turnId, turn]));
  return { status, items: items.sort((a, b) => (takenOrder.get(a.id) ?? Infinity) - (takenOrder.get(b.id) ?? Infinity)), turns: [...linked.values()].sort((a, b) => Number(a.turnId) - Number(b.turnId)),
    messages: messages.sort((a, b) => a.seq - b.seq).map(value => value.message),
    ...(opened.channelChanges ? { channelChanges: opened.channelChanges } : {}) };
}
