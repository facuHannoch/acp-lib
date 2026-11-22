import type { NativeAdapter } from "../adapters.ts";
import type { Agent } from "../agent.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { NativeHarnessHost } from "../native/host.ts";
import type { CreateAgentConversationInput, PersistenceBackend, PersistenceScope } from "../persistence/backend.ts";
import type { ChannelDesire, ChannelPersistence } from "../persistence/channels.ts";

/** Enforce channel lifecycle precedence in the same transaction as a declarative change. */
export function protectPendingRetirement(
  persistence: PersistenceBackend,
  channels: ChannelPersistence,
): ChannelPersistence {
  return {
    desire(channel, desire) {
      if (desire.lifecycle !== "open" && desire.lifecycle !== "suspended") return channels.desire(channel, desire);
      const change = { ...desire };
      return persistence.transaction(async ({ channels: scoped }) => {
        const pending = await scoped!.pendingChange(channel);
        return pending?.desire.lifecycle === "retired" ? pending : scoped!.desire(channel, change);
      });
    },
    pendingChange: channels.pendingChange.bind(channels),
    pendingChanges: channels.pendingChanges.bind(channels),
    confirmChange: channels.confirmChange.bind(channels),
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
  nativeHost: NativeHarnessHost | null,
  checkpoints: boolean,
  deletedAt?: string,
): Promise<number> {
  const { persistence } = agent;
  const remove = async (scope: PersistenceScope) => {
    const count = checkpoints ? (await scope.recoveryCheckpoints?.deleteForConversation?.(id)) ?? 0 : 0;
    await scope.conversations.delete(id, deletedAt);
    return count;
  };
  if (nativeHost && persistence.capabilities.channels) {
    const committed = persistence.transaction(async (scope) => {
      await scope.channels!.desire(id, { lifecycle: "retired" });
      return remove(scope);
    });
    return nativeHost.deliverCommittedChannelChange(id, committed);
  }
  await nativeHost?.changeChannel(id, { lifecycle: "retired" });
  return remove(persistence);
}
