import type { AgentConversationId } from "../agent-ids.ts";
import type { OperationActivity } from "../operations/contracts.ts";
import type { WorkerRow } from "../persistence/workers.ts";

export type WorkerActor = { readonly kind: "consumer" } | {
  readonly kind: "conversation";
  readonly conversationId: AgentConversationId;
  readonly sender: string;
};

export interface WorkerInput {
  readonly text: string;
  readonly about?: string;
}

export interface WorkerSummary extends WorkerRow {
  readonly state: "offline" | "idle" | "busy";
  readonly operation?: OperationActivity;
  readonly sender?: string;
  readonly busyMs?: number;
}

export type OpenWorkerResult = { readonly status: "sent"; readonly handle: string } |
  { readonly status: "no_worker_free"; readonly workers: readonly WorkerSummary[] };

export type SendWorkerResult = { readonly status: "sent" } |
  { readonly status: "busy"; readonly worker: WorkerSummary } |
  { readonly status: "no_worker_free"; readonly workers: readonly WorkerSummary[] };
