import type { ReminderSync } from "./reminders/sync.ts";
import type { ReminderOpenResult } from "./reminders/wire.ts";
import type { ResponseMessage } from "../types.ts";
import { codeOf } from "./errors.ts";
import type { HarnessClient, ItemStatus, PendingChannelChange, StoredMessage, TurnStatus } from "../native-harness/src/client.ts";

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

export async function readCompleteMessage(client: HarnessClient, messageId: string, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const page: { data: string; nextOffset?: number } = signal
      ? await client.request("session/message/read", { messageId, offset }, signal)
      : await client.readMessage({ messageId, offset });
    chunks.push(Buffer.from(page.data, "base64"));
    offset = page.nextOffset;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The catalog and startup edits are installed before recovered work can start. */
export async function openOrCreate(
  client: HarnessClient, config: Pick<Parameters<HarnessClient["openSession"]>[0], "sessionId" | "config">,
  batch: PendingChannelChange[], tools: Parameters<HarnessClient["openSession"]>[0]["tools"], signal: AbortSignal, reminders?: ReminderSync,
) {
  const changes = { ...(batch.length ? { channelChanges: batch } : {}), ...(tools ? { tools } : {}) };
  let staged = await reminders?.stage() ?? [];
  const execute = async (fresh: boolean) => {
    signal.throwIfAborted();
    const params = { sessionId: config.sessionId, config: config.config, ...changes,
      ...(fresh ? { participants: [], channels: {} } : {}) };
    type Result = Awaited<ReturnType<HarnessClient["openSession"]>> & ReminderOpenResult;
    const request = (): Promise<Result> => {
      const payload = { ...params, ...(staged.length ? { reminderChanges: staged } : {}) };
      return fresh ? client.createSession({ ...payload, participants: [], channels: {} }) : client.openSession(payload);
    };
    let result: Result;
    try {
      try { result = await request(); }
      catch (error) {
        if (fresh || codeOf(error) !== "timeout") throw error;
        result = await request();
      }
    } catch (error) {
      if (!staged.length || codeOf(error) !== "invalid_params") throw error;
      await reminders!.rejectedBatch(staged);
      staged = [];
      result = await request();
    }
    return result;
  };
  let fresh = false;
  let result;
  try { result = await execute(false); }
  catch (error) {
    if (codeOf(error) !== "not_found") throw error;
    fresh = true;
    result = await execute(true);
  }
  await reminders?.opened(client, result, config.sessionId, fresh);
  return result;
}

/** Recover only the stopped turn, on one connection and within one shared deadline. */
export async function recoverStoppedReplies(
  client: HarnessClient, channel: string, turnId: string, seen: readonly ResponseMessage[],
): Promise<readonly ResponseMessage[]> {
  const controller = new AbortController();
  const { signal } = controller;
  // Keep the timer across RPCs, including gaps with no abort listener.
  const deadline = setTimeout(() => controller.abort(new DOMException("Native stop reply recovery timed out", "TimeoutError")), 5_000);
  try {
    const known = new Set(seen.map(message => message.messageId));
    const recovered: ResponseMessage[] = [];
    let cursor: string | undefined;
    do {
      const page: Awaited<ReturnType<HarnessClient["reconcileChannel"]>> = await client.request(
        "channel/reconcile", cursor === undefined ? { channel, turnIds: [turnId] } : { channel, cursor }, signal,
      );
      if (page.unknownTurnIds.includes(turnId)) throw new Error(`native stop recovery could not find turn ${turnId}`);
      for (const { messageId } of page.replies) {
        if (known.has(messageId)) continue;
        known.add(messageId);
        recovered.push({ messageId, text: await readCompleteMessage(client, messageId, signal) });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return recovered;
  } finally {
    clearTimeout(deadline);
  }
}
