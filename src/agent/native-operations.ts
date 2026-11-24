import type { AgentConversationId } from "../agent-ids.ts";
import type { AgentHarnessConfig } from "./config.ts";

export const channelSettingsLive = {
  channel: ["displayName", "policy", "lifecycle"],
  sessionTools: ["enable", "remove", "revoke", "restore"],
  restartRequired: ["policies", "defaultPolicy", "model", "system", "toolCatalog", "participants"],
} as const;
export type NativeToolSetting = typeof channelSettingsLive.sessionTools[number];
export type NativeChannelSettings = Readonly<Record<string, unknown>> & {
  readonly displayName?: string | null;
  readonly policy?: string | null;
  readonly lifecycle?: "open" | "suspended" | "retired";
};

export interface NativeRestartOptions {
  readonly when?: "idle" | "now";
  readonly signal?: AbortSignal;
  readonly config?: AgentHarnessConfig["config"];
  readonly functions?: AgentHarnessConfig["functions"] | null;
}

export interface NativeRestartPreview {
  readonly conversationCount: number;
  readonly conversationIds: readonly AgentConversationId[];
}

export type NativeRestartResult = NativeRestartPreview & {
  readonly kind: "restarted" | "restart_failed";
  readonly interruptedTurns: readonly { channel: string; turnId: string }[];
  readonly conversations: readonly { id: AgentConversationId; outcome: "reconnected" | "deferred" | "failed" }[];
  readonly error?: unknown;
};
