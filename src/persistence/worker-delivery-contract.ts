export interface WorkerDestination {
  readonly kind: "native" | "acp";
  readonly id: string;
}

export interface WorkerAssignmentDiscovery {
  readonly destinationKind: WorkerDestination["kind"];
  readonly state: "unstaged" | "pending";
  readonly after?: string;
  readonly limit?: number;
}

export type DiscoveredWorkerAssignment =
  | { readonly state: "unstaged"; readonly binding: WorkerAssignmentBinding }
  | { readonly state: "pending"; readonly staged: StagedWorkerAssignment };

/** Assignment provenance committed before the ACP prompt is sent. */
export interface WorkerAssignmentBinding {
  readonly assignmentId: string;
  readonly workerConversationId: string;
  readonly workerHandle: string;
  readonly messageId: string;
  readonly operationId?: string;
  readonly finalRecordId?: string;
  readonly destination: WorkerDestination;
  readonly originatingPolicyNames: readonly string[];
  readonly contributingPolicyNames: readonly string[];
}

export type WorkerAssignmentFailure = {
  readonly kind: "failed" | "interrupted";
  /** Public terminal reason, at most 128 UTF-8 bytes. Never raw provider text. */
  readonly reason: string;
  readonly possiblePartialEffects: boolean;
};

export type WorkerAssignmentOutcome =
  | { readonly kind: "result"; readonly finalRecordId: string; readonly text: string }
  | WorkerAssignmentFailure
  | { readonly kind: "uncertain" };

export type WorkerDeliveryState = "pending" | "delivered" | "blocked_policy" | "failed_destination";

export interface WorkerDelivery {
  readonly id: string;
  readonly destination: WorkerDestination;
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

export type WorkerAssignmentReservation = Omit<WorkerAssignmentBinding, "operationId" | "finalRecordId">;

export type WorkerAssignmentReplacement =
  | { readonly kind: "replaced" | "old_settled"; readonly reservation: "reserved" | "existing" }
  | { readonly kind: "conflict" };

/** Implementations share the reservation, staging and transition conformance cases in decision 0025. */
export interface WorkerDeliveryRepository {
  reserve(binding: WorkerAssignmentReservation): Promise<"reserved" | "existing" | "conflict">;
  markSteered(workerConversationId: string, messageIds: readonly string[]): Promise<void>;
  continueAssignment(assignmentId: string, predecessorMessageId: string, successorMessageId: string):
    Promise<"continued" | "existing" | "conflict">;
  closeContinuation(assignmentId: string, expectedMessageId: string, failure: WorkerAssignmentFailure):
    Promise<StagedWorkerAssignment | undefined>;
  /** Atomically settles the predecessor if unfinished and reserves the new assignment. */
  replaceAssignment(oldAssignmentId: string, expectedMessageId: string, replacement: WorkerAssignmentReservation):
    Promise<WorkerAssignmentReplacement>;
  discoverAssignments(query: WorkerAssignmentDiscovery):
    Promise<{ readonly assignments: readonly DiscoveredWorkerAssignment[]; readonly next?: string }>;
  /** Find the newest staged assignment, optionally restricted to results or policy-blocked notices. */
  latestOutcome(workerConversationId: string, filter?: "result" | "blocked_policy"): Promise<StagedWorkerAssignment | undefined>;
  /** Record completed output in the same transaction as the final conversation records. */
  recordFinal(workerConversationId: string, operationId: string, messageIds: readonly string[]): Promise<void>;
  /** Stage failure for each causal binding inside its failed terminal commit. */
  recordFailure(
    workerConversationId: string, operationId: string, messageIds: readonly string[], failure: WorkerAssignmentFailure,
  ): Promise<void>;
  readBinding(assignmentId: string): Promise<WorkerAssignmentBinding | undefined>;
  /** Update the destination only before staging. */
  redirect(assignmentId: string, destination: WorkerDestination): Promise<boolean>;
  /** Add policies from taken work before staging. */
  addContributingPolicies(assignmentId: string, names: readonly string[]): Promise<boolean>;
  /** Look up final evidence by causal worker/message ID and write the outcome and notice in the same transaction.
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
