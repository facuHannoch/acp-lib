import type { RunningAssignment } from "./assignments.ts";
import { matchPermissionLevel, mostRestrictivePermissionLevel, type PermissionLevel, type PermissionSettings } from "../permissions/matcher.ts";
import type { NeutralPermissionRequest } from "../permissions/request.ts";
import { WorkerPolicyError } from "../errors.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { DelegationPolicy, WorkerActor } from "./contracts.ts";

export function canSeeWorker(actor: WorkerActor, row: WorkerRow, running?: RunningAssignment): boolean {
  return actor.kind === "consumer" || actor.policy.scope === "all"
    || row.openedBy === actor.conversationId || running?.destination === actor.conversationId;
}

export function requireWorkerUse(actor: WorkerActor): void {
  if (actor.kind === "conversation" && !actor.policy.use) throw new WorkerPolicyError("use");
}

export function composeDelegationPolicy(policies: readonly DelegationPolicy[]): DelegationPolicy {
  if (!policies.length) throw new Error("at least one delegation policy is required");
  const cap = Math.min(...policies.map(policy => policy.maxOpen ?? Infinity));
  return {
    use: policies.every(policy => policy.use),
    scope: policies.every(policy => policy.scope === "all") ? "all" : "none",
    redirect: policies.every(policy => policy.redirect),
    ...(cap === Infinity ? {} : { maxOpen: cap }),
  };
}

/** Match within each policy before reducing so each policy uses its own fallback. */
export function matchWorkerPermissionLevel(
  request: Partial<Pick<NeutralPermissionRequest, "tool">>, policies: readonly PermissionSettings[],
): PermissionLevel {
  if (!policies.length) return "ask";
  return policies.map(policy => matchPermissionLevel(request, policy)).reduce(mostRestrictivePermissionLevel);
}

export function requireWorkerRedirect(actor: WorkerActor): void {
  if (actor.kind === "conversation" && !actor.policy.redirect) throw new WorkerPolicyError("redirect");
}

export function checkWorkerOpenLimit(actor: WorkerActor, rows: readonly WorkerRow[]): void {
  if (actor.kind === "consumer" || actor.policy.maxOpen === undefined) return;
  const count = rows.filter(row => row.openedBy === actor.conversationId && row.droppedAt === undefined).length;
  if (count >= actor.policy.maxOpen) throw new WorkerPolicyError("maxOpen");
}
