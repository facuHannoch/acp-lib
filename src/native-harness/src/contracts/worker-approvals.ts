export const WORKER_APPROVAL_SERVE = "context/worker-approvals/serve";
export const WORKER_APPROVAL_READ = "context/worker-approvals/read";
export const MAX_WORKER_APPROVAL_BYTES = 4096;
export const MAX_WORKER_APPROVALS = 4;

/** The harness binds this query to the current inference. */
export interface WorkerApprovalQuery {
  channel: string;
  policyNames: readonly string[];
}

/** A bounded, live view held outside the session timeline. */
export interface WorkerApprovalView {
  request: string;
  worker: string;
  action: { kind: string; details: unknown };
  choices: readonly ("allow_once" | "reject_once")[];
  expiresAt: number;
}

/** Host lookup over its in-memory permission coordinator. */
export type WorkerApprovalReader = (query: WorkerApprovalQuery) => readonly WorkerApprovalView[];

/** Harness-side callback bound to the current managed connection. */
export type ReadWorkerApprovals = (query: WorkerApprovalQuery, signal: AbortSignal) => Promise<readonly WorkerApprovalView[]>;
