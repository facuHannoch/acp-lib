import type { PersistenceBackend, PersistenceScope } from "../persistence/backend.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { WorkerAssignmentReservation, WorkerDestination } from "../persistence/worker-delivery-contract.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { AssignmentPlan, RefusedSteer, RunningAssignment, WorkerAssignmentPort } from "./assignments.ts";
import { REFUSED_STEER_REASONS } from "../persistence/worker-terminal-reason.ts";
import type { WorkerConversationActor } from "./contracts.ts";

export class WorkerAssignmentConflict extends Error {
  constructor() { super("worker assignment conflict"); }
}

export class DurableWorkerAssignments implements WorkerAssignmentPort {
  constructor(
    private readonly persistence: PersistenceBackend,
    private readonly flushAcp: () => Promise<void>,
    private readonly flushNative: () => Promise<void> | undefined,
  ) {}

  async beforeDispatch(
    row: WorkerRow, plan: AssignmentPlan, messageId: string, policyNames: readonly string[], actor?: WorkerConversationActor,
  ): Promise<RunningAssignment | void> {
    const target = plan.assignment.destination;
    if (!target) return;
    const accepted = await this.persistence.transaction(async scope => {
      const repository = scope.workerDelivery!;
      const destination = await this.destination(scope, target, actor?.destinationKind);
      const binding = this.binding(row, plan.assignment.id, messageId, destination, policyNames);
      // A local consumer's work has no delivery destination and therefore no predecessor binding.
      if (plan.kind === "start" || !plan.previous.destination) {
        if (await repository.reserve(binding) !== "reserved") throw new WorkerAssignmentConflict();
        return false;
      }
      const old = await repository.readBinding(plan.previous.id);
      if (!old || old.workerConversationId !== row.conversationId) throw new WorkerAssignmentConflict();
      if (plan.kind === "continue" && old.finalRecordId && actor) {
        const result = await repository.replaceAssignment(old.assignmentId, old.messageId, { ...binding, assignmentId: actor.invocationId });
        if (result.kind !== "old_settled" || result.reservation !== "reserved") throw new WorkerAssignmentConflict();
        return { id: actor.invocationId, destination: target };
      }
      if (plan.kind === "replace") {
        const result = await repository.replaceAssignment(old.assignmentId, old.messageId, binding);
        if (result.kind === "conflict" || result.reservation !== "reserved") throw new WorkerAssignmentConflict();
        return result.kind === "replaced";
      }
      if (await repository.continueAssignment(old.assignmentId, old.messageId, messageId) !== "continued"
        || !await repository.addContributingPolicies(old.assignmentId, policyNames)
        || (old.destination.id !== destination.id && !await repository.redirect(old.assignmentId, destination))) {
        throw new WorkerAssignmentConflict();
      }
      return false;
    });
    if (accepted === true) void this.flushNative();
    if (plan.kind === "replace") void this.flushAcp();
    if (typeof accepted === "object") return accepted;
  }

  async refuse(row: WorkerRow, plan: AssignmentPlan, { actor, cause }: RefusedSteer): Promise<void> {
    await this.persistence.transaction(async scope => {
      const repository = scope.workerDelivery!;
      const old = plan.kind === "start" ? undefined : await repository.readBinding(plan.previous.id);
      if (old?.workerConversationId === row.conversationId) {
        await repository.closeContinuation(old.assignmentId, old.messageId, {
          kind: "interrupted", reason: "worker interrupted by steering", possiblePartialEffects: true,
        });
      }
      const destination = await this.destination(scope, actor.conversationId, actor.destinationKind);
      // The refusal is a separate notice. Its synthetic cause never reaches the worker and cannot
      // take over the predecessor's binding or reuse a conflicting replacement invocation ID.
      const id = `refused-steer:${actor.invocationId}`;
      const reserved = await repository.reserve(this.binding(row, id, id, destination, actor.policyNames));
      if (reserved === "conflict") throw new WorkerAssignmentConflict();
      if (reserved === "reserved") await repository.recordFailure(row.conversationId, id, [id], {
        kind: "failed",
        reason: REFUSED_STEER_REASONS[cause],
        possiblePartialEffects: false,
      });
    });
    void this.flushNative();
  }

  async settled(): Promise<void> {
    await Promise.all([this.flushAcp(), this.flushNative()]);
  }

  latestOutcome(row: WorkerRow) { return this.persistence.workerDelivery!.latestOutcome(row.conversationId); }
  latestResult(row: WorkerRow) { return this.persistence.workerDelivery!.latestOutcome(row.conversationId, "result"); }

  private async destination(scope: PersistenceScope, id: AgentConversationId, kind?: WorkerDestination["kind"]): Promise<WorkerDestination> {
    return { id, kind: (await scope.conversations.get(id))?.controllerKind ?? kind ?? "acp" };
  }

  private binding(
    row: WorkerRow, assignmentId: string, messageId: string, destination: WorkerDestination, policyNames: readonly string[],
  ): WorkerAssignmentReservation {
    return {
      assignmentId, messageId, destination, workerConversationId: row.conversationId, workerHandle: row.handle,
      originatingPolicyNames: policyNames, contributingPolicyNames: policyNames,
    };
  }
}
