import type { AgentConversationId } from "../agent-ids.ts";
import type { WorkerRow } from "../persistence/workers.ts";

export interface RunningAssignment {
  readonly id: string;
  readonly destination?: AgentConversationId;
}

export type AssignmentPlan =
  | { readonly kind: "start"; readonly assignment: RunningAssignment }
  | { readonly kind: "continue"; readonly previous: RunningAssignment; readonly assignment: RunningAssignment }
  | { readonly kind: "replace"; readonly previous: RunningAssignment; readonly assignment: RunningAssignment };

/** The assignment implementation is supplied separately. The pool only knows the dispatch boundary. */
export interface WorkerAssignmentPort {
  beforeDispatch(row: WorkerRow, plan: AssignmentPlan, messageId: string): Promise<void>;
}
