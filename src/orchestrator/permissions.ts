import type { PermissionSettings } from "../permissions/matcher.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import { forwardPermission } from "../permissions/conversation.ts";
import { selectPermissionOutcome, unansweredPermissionOutcome } from "../permissions/outcome.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { PromptHandlers } from "../types.ts";
import type { WorkerActor } from "./contracts.ts";
import { matchWorkerPermissionLevel } from "./policy.ts";

export type FindGivingConversation = (id: AgentConversationId) => object | undefined;

export function workerPermissionHandler(
  actor: WorkerActor, worker: WorkerRow, findGivingConversation?: FindGivingConversation, defaults: readonly PermissionSettings[] = [],
): NonNullable<PromptHandlers["onPermissionRequest"]> {
  return (request, signal) => {
    const policies = actor.kind === "consumer" ? defaults : actor.workerPermissions;
    const level = matchWorkerPermissionLevel(request, policies);
    if (level !== "ask") return selectPermissionOutcome(level, request.options)!;
    const unanswered = policies.some(policy => policy.unanswered === "cancel") ? "cancel" : "reject";
    if (actor.kind === "consumer") return unansweredPermissionOutcome(request.options, unanswered);
    return forwardPermission(findGivingConversation?.(actor.conversationId), request, {
      source: { kind: "worker", handle: worker.handle, conversationId: worker.conversationId },
      includeAllowAlways: actor.isOwner === true,
      unanswered,
      signal,
    });
  };
}
