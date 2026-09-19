import type { AgentConversationId } from "../agent-ids.ts";
import type { ConversationMessagePersistence } from "../persistence/backend.ts";
import type { ConversationRecoveryCheckpoint } from "./contracts.ts";
import type { ResolvedConversationRecoveryConfig } from "./config.ts";

export interface ConversationRecoveryProgress {
  readonly stage: "load_failed" | "loading_checkpoint" | "creating_session" | "seeding" | "completed";
  readonly checkpointId?: string;
}

export interface ConversationRecoveryResult {
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly recoveredThroughSequence: number;
  readonly previousInternalSessionId: string;
  readonly newInternalSessionId: string;
}

export function isMissingProviderSessionError(
  error: unknown,
  override?: (error: unknown) => boolean,
): boolean {
  if (override) return override(error);
  const value = error as { code?: unknown; message?: unknown; data?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error);
  const data = isRecord(value?.data) ? value.data : undefined;
  // OpenCode's ACP adapter currently collapses a deleted session into this generic
  // service error. The service discriminator is the only machine-readable signal it
  // exposes, so keep the match deliberately exact and scoped to the session service.
  if (
    value?.code === -32603
    && message.toLowerCase() === "internal error: opencode service failure"
    && data?.service === "session"
  ) return true;
  const text = [
    message,
    safeJson(value?.data),
  ].join(" ").toLowerCase();
  return [
    "failed to resolve rollout path",
    "no rollout found for thread id",
    "session not found",
    "unknown session",
    "no such session",
    "session does not exist",
    "file does not exist",
  ].some((pattern) => text.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function buildRecoverySeed(
  messages: ConversationMessagePersistence,
  conversationId: AgentConversationId,
  checkpoint: ConversationRecoveryCheckpoint,
  latestSequence: number,
  config: ResolvedConversationRecoveryConfig,
): Promise<{ readonly prompt: string; readonly recoveredThroughSequence: number }> {
  const tail = await readTailMessages(
    messages,
    conversationId,
    checkpoint.coveredSequence,
    latestSequence,
    config.maxTailMessages,
  );
  return Object.freeze({
    prompt: [
      config.seedInstruction,
      `Continuation checkpoint through canonical sequence ${checkpoint.coveredSequence}:`,
      checkpoint.summary,
      tail.length
        ? `Canonical messages after the checkpoint:\n${JSON.stringify(tail)}`
        : "There are no canonical messages after the checkpoint.",
    ].join("\n\n"),
    recoveredThroughSequence: tail.at(-1)?.sequence ?? checkpoint.coveredSequence,
  });
}

async function readTailMessages(
  repository: ConversationMessagePersistence,
  conversationId: AgentConversationId,
  afterSequence: number,
  throughSequence: number,
  limit: number,
) {
  if (limit === 0 || throughSequence <= afterSequence) return [];
  const values: Array<{ sequence: number; role: string; participantId?: string; content: unknown }> = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(conversationId, {
      afterSequence,
      throughSequence,
      limit: Math.min(limit, 1_000),
      ...(cursor ? { cursor } : {}),
    });
    for (const message of page.messages) {
      values.push({
        sequence: message.sequence,
        role: message.role,
        ...(message.participantId ? { participantId: message.participantId } : {}),
        content: message.content,
      });
      if (values.length >= limit) return values;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}
