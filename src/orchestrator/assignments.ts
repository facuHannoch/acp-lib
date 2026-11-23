import type { AgentConversationId } from "../agent-ids.ts";
import type { WorkerRow } from "../persistence/workers.ts";
import type { StagedWorkerAssignment } from "../persistence/worker-delivery-contract.ts";
import type { WorkerConversationActor } from "./contracts.ts";

export interface RunningAssignment {
  readonly id: string;
  readonly destination?: AgentConversationId;
}

export type AssignmentPlan =
  | { readonly kind: "start"; readonly assignment: RunningAssignment }
  | { readonly kind: "continue"; readonly previous: RunningAssignment; readonly assignment: RunningAssignment }
  | { readonly kind: "replace"; readonly previous: RunningAssignment; readonly assignment: RunningAssignment };

export type WorkingPlan = Exclude<AssignmentPlan, { kind: "start" }>;
export type RefusedSteerCause = "conflict" | "hook_error";
export type RefusedSteer = { readonly actor: WorkerConversationActor; readonly cause: RefusedSteerCause };

/** The assignment implementation is supplied separately. The pool only knows the dispatch boundary. */
export interface WorkerAssignmentPort {
  beforeDispatch(row: WorkerRow, plan: AssignmentPlan, messageId: string, policyNames: readonly string[], actor?: WorkerConversationActor): Promise<void>;
  refuse?(row: WorkerRow, plan: WorkingPlan, refusal: RefusedSteer): Promise<void>;
  settled?(): Promise<void>;
  latestOutcome?(row: WorkerRow): Promise<StagedWorkerAssignment | undefined>;
}
