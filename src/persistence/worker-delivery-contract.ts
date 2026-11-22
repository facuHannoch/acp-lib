/** Assignment provenance committed before the ACP prompt is sent. */
export interface WorkerAssignmentBinding {
  readonly assignmentId: string;
  readonly workerConversationId: string;
  readonly operationId: string;
  readonly destination: string;
  readonly originatingPolicyNames: readonly string[];
  readonly contributingPolicyNames: readonly string[];
}

export type WorkerAssignmentOutcome =
  | { readonly kind: "result"; readonly finalRecordId: string; readonly text: string }
  | { readonly kind: "uncertain" };

export type WorkerDeliveryState = "pending" | "delivered" | "blocked_policy" | "failed_destination";

export interface WorkerDelivery {
  readonly id: string;
  readonly destination: string;
  readonly source: string;
  readonly text: string;
  readonly policyNames: readonly string[];
  readonly state: WorkerDeliveryState;
}

export interface StagedWorkerAssignment {
  readonly assignmentId: string;
  readonly outcome: WorkerAssignmentOutcome;
  readonly delivery: WorkerDelivery;
}

/** Implementations share the reservation, staging and transition conformance cases in decision 0025. */
export interface WorkerDeliveryRepository {
  reserve(binding: WorkerAssignmentBinding): Promise<"reserved" | "existing" | "conflict">;
  /** Record completed output in the same transaction as the final conversation records. */
  recordFinal(workerConversationId: string, operationId: string): Promise<void>;
  readBinding(assignmentId: string): Promise<WorkerAssignmentBinding | undefined>;
  /** Update the destination only before staging. */
  redirect(assignmentId: string, destination: string): Promise<boolean>;
  /** Add policies from taken work before staging. */
  addContributingPolicies(assignmentId: string, names: readonly string[]): Promise<boolean>;
  /** Look up final evidence and write the outcome and notice in the same transaction.
   * Uncertainty is allowed only for inherited unfinished work under exclusive writer ownership.
   * Repeated calls return the existing stage; a live unfinished operation returns undefined.
   */
  stage(assignmentId: string): Promise<StagedWorkerAssignment | undefined>;
  readStaged(assignmentId: string): Promise<StagedWorkerAssignment | undefined>;
  /** Apply an allowed transition only if the delivery is still in the expected state.
   * Only explicit retry may move blocked_policy to pending.
   */
  transitionDelivery(id: string, transition:
    | { readonly from: "pending"; readonly to: Exclude<WorkerDeliveryState, "pending"> }
    | { readonly from: "blocked_policy"; readonly to: "pending"; readonly explicitRetry: true }
  ): Promise<boolean>;
}
