import { activatesRoutine, RoutineAdmission } from "./reminders/routine-guard.ts";
import type { ReminderChange } from "../persistence/reminders.ts";
import type { ReminderSync } from "./reminders/sync.ts";
import { type ReminderWireOpen, type RoutineConfig } from "./reminders/routine-wire.ts";
import type { ResponseMessage } from "../types.ts";
import { codeOf } from "./errors.ts";
import { HarnessClientError, type HarnessClient, type ItemStatus, type PendingChannelChange, type StoredMessage, type TurnStatus } from "../native-harness/src/client.ts";

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
  client: HarnessClient, config: { sessionId: string; config?: RoutineConfig },
  batch: PendingChannelChange[], tools: Parameters<HarnessClient["openSession"]>[0]["tools"], signal: AbortSignal, reminders?: ReminderSync,
) {
  const admission = reminders?.routineAdmission ?? new RoutineAdmission();
  admission.configForOpen(config.config); // Validate before marking any journal entry maybe sent.
  const changes = { ...(batch.length ? { channelChanges: batch } : {}), ...(tools ? { tools } : {}) };
  const originals: ReminderChange[] = [];
  const frozen = await reminders?.startupRetry(config.sessionId);
  let staged = frozen ?? await reminders?.stage(change => !activatesRoutine(change), originals) ?? [];
  let storageAttempts = 0;
  let replacement = await reminders?.replacementAttempted(config.sessionId) ?? false;
  const execute = async (initialCreate: boolean): Promise<ReminderWireOpen> => {
    let create = initialCreate;
    let timeoutRetried = false;
    for (;;) {
      signal.throwIfAborted();
      const params = {
        sessionId: config.sessionId, config: admission.configForOpen(config.config), ...changes,
        ...(staged.length ? { reminderChanges: staged } : {}),
      };
      try {
        return create
          ? await client.createSession({ ...params, participants: [], channels: {} })
          : await client.openSession(params);
      } catch (error) {
        const code = codeOf(error);
        if (staged.length && code === "storage_failure") {
          if (++storageAttempts === 1 && !frozen) await reminders?.freezeStartupRetry(config.sessionId, staged);
          if (storageAttempts === 3) {
            throw new HarnessClientError("reminder_batch_retry_exhausted", "Startup reminder batch exhausted three attempts");
          }
          // Create can publish before failing. The same frozen batch goes through
          // open thereafter. Never infer the failure point from error.data.
          create = false;
          continue;
        }
        if (storageAttempts || (frozen && code !== "not_found")) throw error;
        if (code === "invalid_config") {
          await reminders?.restoreStaged(originals);
          if (create) await reminders?.setReplacementAttempted(undefined);
        }
        if (code === "timeout" && !create && !timeoutRetried) {
          timeoutRetried = true;
          continue;
        }
        if (!staged.length || code !== "invalid_params") throw error;
        const rejected = staged;
        staged = [];
        const { reminderChanges: _rejected, ...unbatched } = params;
        let result: ReminderWireOpen;
        try {
          result = create
            ? await client.createSession({ ...unbatched, participants: [], channels: {} })
            : await client.openSession(unbatched);
        } catch (retryError) {
          await reminders!.restoreStaged(originals);
          throw retryError;
        }
        await reminders!.rejectedBatch(rejected);
        return result;
      }
    }
  };
  let result;
  try { result = await execute(false); }
  catch (error) {
    // Confirmed absence means the prior create never published. A marker
    // still fences a replacement if open finds it, but cannot veto creation.
    if (storageAttempts || codeOf(error) !== "not_found" || (frozen && !replacement)) throw error;
    replacement = true;
    await reminders?.setReplacementAttempted(config.sessionId);
    admission.resetBinding();
    result = await execute(true);
  }
  await reminders?.opened(client, result, config.sessionId, replacement);
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

export async function commitChannelCatchUp(
  client: HarnessClient, channel: string, after: string, committed: Set<string>,
  commit: (messages: Awaited<ReturnType<HarnessClient["channelMessages"]>>["messages"], position: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { revision } = await client.observeChannel({ channel });
  let position = after;
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await client.channelMessages(cursor === undefined
      ? { channel, after, throughRevision: revision } : { channel, cursor });
    signal?.throwIfAborted();
    if (page.messages.length) {
      const next = page.messages.at(-1)!.position;
      await commit(page.messages, next);
      position = next;
      for (const message of page.messages) committed.add(message.messageId);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return position;
}
