import type { PermissionSettings } from "../permissions/matcher.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { OperationActivity } from "../operations/contracts.ts";
import type { WorkerRow } from "../persistence/workers.ts";

export interface DelegationPolicy {
  readonly use: boolean;
  readonly scope: "none" | "all";
  readonly redirect: boolean;
  readonly maxOpen?: number;
}

export type WorkerActor = { readonly kind: "consumer" } | {
  readonly kind: "conversation";
  readonly conversationId: AgentConversationId;
  readonly sender: string;
  readonly invocationId: string;
  readonly policyNames: readonly string[];
  readonly policy: DelegationPolicy;
  readonly workerPermissions: readonly PermissionSettings[];
};

export interface WorkerInput {
  readonly text: string;
  readonly about?: string;
}

export interface SendWorkerInput extends WorkerInput {
  readonly redirect?: boolean;
  readonly assignment?: "new";
}

export interface WorkerSummary extends WorkerRow {
  readonly state: "offline" | "idle" | "busy";
  readonly operation?: OperationActivity;
  readonly sender?: string;
  readonly busyMs?: number;
}

export type OpenWorkerResult = { readonly status: "sent"; readonly handle: string } |
  { readonly status: "no_worker_free"; readonly workers: readonly WorkerSummary[] };

export type SendWorkerResult = { readonly status: "sent" | "steered" } |
  { readonly status: "busy"; readonly worker: WorkerSummary } |
  { readonly status: "no_worker_free"; readonly workers: readonly WorkerSummary[] };

interface WorkerEventIdentity {
  readonly handle: string;
  readonly conversationId: AgentConversationId;
  readonly openedBy: WorkerRow["openedBy"];
  readonly lastConversation?: AgentConversationId;
}

export type WorkerEvent = WorkerEventIdentity & (
  | { readonly kind: "worker_opened" | "worker_busy" | "worker_idle" | "worker_replied" | "worker_reloaded" | "worker_dropped" }
  | { readonly kind: "worker_redirected"; readonly previousConversation?: AgentConversationId }
  | { readonly kind: "worker_failed"; readonly reason: string }
  | { readonly kind: "worker_stopped"; readonly reason: "eviction" | "requested" | "idle" }
);
