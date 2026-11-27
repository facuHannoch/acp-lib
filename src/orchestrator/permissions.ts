import type { OrchestratorConfig } from "./config.ts";
import type { NativeHarnessHost } from "../native/host.ts";
import { describeModelApproval } from "./model-approval.ts";
import type { PermissionSettings } from "../permissions/matcher.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import { forwardPermission } from "../permissions/conversation.ts";
import { selectPermissionOutcome, unansweredPermissionOutcome } from "../permissions/outcome.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { PromptHandlers } from "../types.ts";
import type { WorkerActor } from "./contracts.ts";
import { matchWorkerPermissionLevel } from "./policy.ts";

export interface WorkerApprovalRouting {
  readonly config: OrchestratorConfig;
  readonly send: NativeHarnessHost["sendWorkerApprovalNotice"];
}

export type FindGivingConversation = (id: AgentConversationId) => object | undefined;

export function workerPermissionHandler(
  actor: WorkerActor, worker: WorkerRow, findGivingConversation?: FindGivingConversation, defaults: readonly PermissionSettings[] = [], approvals?: WorkerApprovalRouting,
): NonNullable<PromptHandlers["onPermissionRequest"]> {
  return (request, signal) => {
    const policies = actor.kind === "consumer" ? defaults : actor.workerPermissions;
    const level = matchWorkerPermissionLevel(request, policies);
    if (level !== "ask") return selectPermissionOutcome(level, request.options)!;
    const unanswered = policies.some(policy => policy.unanswered === "cancel") ? "cancel" : "reject";
    if (actor.kind === "consumer") return unansweredPermissionOutcome(request.options, unanswered);
    const mode = approvals?.config.workerApprovals;
    const description = approvals && (mode === "model" || mode === "both") && actor.destinationKind === "native" &&
      request.options.some(option => option.kind === "allow_once" || option.kind === "reject_once")
      ? describeModelApproval(approvals.config, actor.policyNames, request) : undefined;
    return forwardPermission(findGivingConversation?.(actor.conversationId), request, {
      source: { kind: "worker", handle: worker.handle, conversationId: worker.conversationId },
      ...(approvals && description && (mode === "model" || mode === "both") ? { model: {
        mode,
        authorize: policies => describeModelApproval(approvals.config, policies, request) === description,
        deliver: (id, choices, expiresAt, liveSignal) => approvals.send(actor.conversationId, {
          id: `worker-approval:${id}`, source: worker.handle, policyNames: [...actor.policyNames],
          text: JSON.stringify({ kind: "worker_approval", worker: worker.handle, action: description,
            request: id, choices, expiresAt }),
        }, liveSignal),
      } } : {}),
      includeAllowAlways: actor.isOwner === true,
      unanswered,
      signal,
    });
  };
}
