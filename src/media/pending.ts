import type { AgentConversationId } from "../agent-ids.ts";
import { supportsCopy, type MediaCapabilities } from "./acp.ts";
import { isMediaPart, mediaMention, type ResolvedPart } from "./parts.ts";

/**
 * Out-of-band parts waiting for the next turn, as they were appended, keyed by record id. They live
 * in memory only: parts that are not kept (`keep: false`, `record: false`) are never written
 * anywhere. After a restart a waiting message is delivered from its record, and a copy whose bytes
 * were not kept is named instead of sent.
 */
export type PendingOutOfBandParts = Map<string, {
  readonly owner: AgentConversationId;
  readonly parts: readonly ResolvedPart[];
}>;

const pendingByAgent = new WeakMap<object, PendingOutOfBandParts>();

/** The waiting parts of one Agent. */
export function pendingOutOfBandParts(agent: object): PendingOutOfBandParts {
  let pending = pendingByAgent.get(agent);
  if (!pending) {
    pending = new Map();
    pendingByAgent.set(agent, pending);
  }
  return pending;
}

/** Drop the waiting parts of one conversation. */
export function forgetPendingParts(agent: object, owner: AgentConversationId): void {
  const pending = pendingOutOfBandParts(agent);
  for (const [recordId, entry] of pending) if (entry.owner === owner) pending.delete(recordId);
}

/**
 * What an out-of-band message can deliver to this agent. Its parts were accepted when it was appended,
 * whatever agent would read them, so a copy the agent cannot take is named instead of refusing the
 * turn: a refused turn would never deliver it, and every later turn would fail the same way. A pty
 * agent takes text only.
 */
export function deliverableParts(
  parts: readonly ResolvedPart[],
  capabilities: MediaCapabilities | undefined,
  degraded = false,
): readonly ResolvedPart[] {
  return parts.map((part): ResolvedPart => {
    if (!isMediaPart(part)) return part;
    if (degraded) return { kind: "text", text: mediaMention(part) };
    if (part.mode === "link" || supportsCopy(part.kind, capabilities)) return part;
    return { kind: "text", text: mediaMention(part, "not supported by this agent") };
  });
}
