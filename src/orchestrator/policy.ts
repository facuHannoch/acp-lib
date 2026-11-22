import { WorkerPolicyError } from "../errors.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { WorkerActor } from "./contracts.ts";

export function requireWorkerScope(actor: WorkerActor): void {
  if (actor.kind === "conversation" && actor.policy.scope !== "all") throw new WorkerPolicyError("scope");
}

export function requireWorkerUse(actor: WorkerActor): void {
  if (actor.kind === "conversation" && !actor.policy.use) throw new WorkerPolicyError("use");
  requireWorkerScope(actor);
}

export function requireWorkerRedirect(actor: WorkerActor): void {
  if (actor.kind === "conversation" && !actor.policy.redirect) throw new WorkerPolicyError("redirect");
}

export function checkWorkerOpenLimit(actor: WorkerActor, rows: readonly WorkerRow[]): void {
  if (actor.kind === "consumer" || actor.policy.maxOpen === undefined) return;
  const count = rows.filter(row => row.openedBy === actor.conversationId && row.droppedAt === undefined).length;
  if (count >= actor.policy.maxOpen) throw new WorkerPolicyError("maxOpen");
}
