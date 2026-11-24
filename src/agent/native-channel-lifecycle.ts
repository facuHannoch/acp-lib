import type { NativeAdapter } from "../adapters.ts";
import type { Agent } from "../agent.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { DeleteConversationOptions } from "./config.ts";
import type { CreateAgentConversationInput, PersistenceBackend, PersistenceScope } from "../persistence/backend.ts";
import type { ChannelDesire, ChannelPersistence } from "../persistence/channels.ts";

/** Enforce channel lifecycle precedence in the same transaction as a declarative change. */
export function protectPendingRetirement(
  persistence: PersistenceBackend,
  channels: ChannelPersistence,
): ChannelPersistence {
  return {
    desire(channel, desire) {
      if (desire.lifecycle === undefined) return channels.desire(channel, desire);
      const change = { ...desire };
      return persistence.transaction(async ({ channels: scoped, reminders }) => {
        const pending = await scoped!.pendingChange(channel);
        if (pending?.desire.lifecycle === "retired" && change.lifecycle !== "retired") return pending;
        const result = await scoped!.desire(channel, change);
        await reminders?.setConversationSuspended(channel, change.lifecycle !== "open");
        return result;
      });
    },
    pendingChange: channels.pendingChange.bind(channels),
    pendingChanges: channels.pendingChanges.bind(channels),
    confirmChange(channel, version) {
      return persistence.transaction(async ({ channels: scoped, reminders }) => {
        const pending = await scoped!.pendingChange(channel);
        const confirmed = await scoped!.confirmChange(channel, version);
        if (confirmed && pending?.version === version && pending.desire.lifecycle !== undefined) {
          await reminders?.setConversationSuspended(channel, pending.desire.lifecycle !== "open");
        }
        return confirmed;
      });
    },
  };
}

export function initialChannelDesire(adapter: NativeAdapter, title?: string): ChannelDesire | undefined {
  if (title === undefined && adapter.defaultPolicy === undefined) return undefined;
  return {
    ...(title !== undefined ? { displayName: title } : {}),
    ...(adapter.defaultPolicy !== undefined ? { policy: adapter.defaultPolicy } : {}),
  };
}

/** Stores the initial settings alongside the conversation row when the backend supports channel intents. */
export async function createConversationWithChannel(
  agent: Agent,
  input: CreateAgentConversationInput,
  adapter: NativeAdapter | null,
): Promise<boolean> {
  const { persistence, nativeHarness } = agent;
  input = { ...input, controllerKind: adapter ? "native" : "acp" };
  const desire = adapter && initialChannelDesire(adapter, input.title);
  if (!nativeHarness || !persistence.capabilities.channels || !desire) {
    await persistence.conversations.create(input);
    return false;
  }
  const committed = persistence.transaction(async (scope) => {
    await scope.conversations.create(input);
    await scope.channels!.desire(input.agentConversationId, desire);
  });
  await nativeHarness.deliverCommittedChannelChange(input.agentConversationId, committed);
  return true;
}

export async function deleteConversationWithChannel(
  agent: Agent,
  id: AgentConversationId,
  { checkpoints, deletedAt, providerSession }: DeleteConversationOptions,
  liveAdapterId?: string,
) {
  const { persistence, nativeHarness } = agent;
  const classify = async (scope: PersistenceScope) => {
    const kind = (await scope.conversations.get(id))?.controllerKind;
    const descriptor = kind !== "native" && (kind === undefined || providerSession === "best-effort")
      ? await scope.providerSessions.active(id)
      : null;
    const adapterId = descriptor?.adapterId ?? liveAdapterId;
    const retired = kind === "native" || (kind === undefined && !!adapterId && agent.adapters.native(adapterId) !== null);
    return { retired, active: !retired && providerSession === "best-effort" ? descriptor : null };
  };
  const remove = async (scope: PersistenceScope) => {
    const count = checkpoints ? (await scope.recoveryCheckpoints?.deleteForConversation?.(id)) ?? 0 : 0;
    await scope.reminders?.deleteConversation(id);
    await scope.conversations.delete(id, deletedAt);
    return count;
  };
  if (persistence.capabilities.channels) {
    const committed = persistence.transaction(async (scope) => {
      const disposition = await classify(scope);
      if (disposition.retired) await scope.channels!.desire(id, { lifecycle: "retired" });
      return { ...disposition, checkpointsDeleted: await remove(scope) };
    });
    return nativeHarness ? nativeHarness.deliverCommittedChannelChange(id, committed, ({ retired }) => retired) : committed;
  }
  const disposition = await classify(persistence);
  if (disposition.retired) await nativeHarness?.changeChannel(id, { lifecycle: "retired" });
  const checkpointsDeleted = persistence.reminders ? await persistence.transaction(remove) : await remove(persistence);
  return { ...disposition, checkpointsDeleted };
}

export function protectedChannels(persistence: PersistenceBackend): ChannelPersistence | undefined {
  if (!persistence.capabilities.channels) return undefined;
  if (!persistence.channels) {
    throw new Error("The persistence backend advertises channel intents but provides no channels repository");
  }
  return protectPendingRetirement(persistence, persistence.channels);
}
