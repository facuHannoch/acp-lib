import type { AgentConversationId } from "../agent-ids.ts";
import { forwardPermission } from "../permissions/conversation.ts";
import { selectPermissionOutcome } from "../permissions/outcome.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { PromptHandlers } from "../types.ts";
import type { WorkerActor } from "./contracts.ts";
import { matchWorkerPermissionLevel } from "./policy.ts";

export type FindGivingConversation = (id: AgentConversationId) => object | undefined;

export function workerPermissionHandler(
  actor: WorkerActor, worker: WorkerRow, findGivingConversation?: FindGivingConversation,
): NonNullable<PromptHandlers["onPermissionRequest"]> {
  return (request, signal) => {
    if (actor.kind === "consumer") return selectPermissionOutcome("deny", request.options)!;
    const level = matchWorkerPermissionLevel(request, actor.workerPermissions);
    if (level !== "ask") return selectPermissionOutcome(level, request.options)!;
    return forwardPermission(findGivingConversation?.(actor.conversationId), request, {
      source: { kind: "worker", handle: worker.handle, conversationId: worker.conversationId },
      includeAllowAlways: actor.isOwner === true,
      signal,
    });
  };
}
