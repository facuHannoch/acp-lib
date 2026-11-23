import type { PermissionSettings } from "../permissions/matcher.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import { forwardPermission } from "../permissions/conversation.ts";
import { selectPermissionOutcome } from "../permissions/outcome.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { PromptHandlers } from "../types.ts";
import type { WorkerActor } from "./contracts.ts";
import { matchWorkerPermissionLevel } from "./policy.ts";

export type FindGivingConversation = (id: AgentConversationId) => object | undefined;

export function workerPermissionHandler(
  actor: WorkerActor, worker: WorkerRow, findGivingConversation?: FindGivingConversation, defaults: readonly PermissionSettings[] = [],
): NonNullable<PromptHandlers["onPermissionRequest"]> {
  return (request, signal) => {
    const level = matchWorkerPermissionLevel(request, actor.kind === "consumer" ? defaults : actor.workerPermissions);
    if (level !== "ask") return selectPermissionOutcome(level, request.options)!;
    if (actor.kind === "consumer") return selectPermissionOutcome("deny", request.options)!;
    return forwardPermission(findGivingConversation?.(actor.conversationId), request, {
      source: { kind: "worker", handle: worker.handle, conversationId: worker.conversationId },
      includeAllowAlways: actor.isOwner === true,
      signal,
    });
  };
}
