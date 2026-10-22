// Shared types for the operation lifecycle: what a supervised provider request looks like from the
// outside (its stage and timestamps) and what the provider is observed to send while it runs.
// Spec: .res/somelogs.md/9-22+/10-17-SPEC-operation-lifecycle.md.

import type { ActivityEvent } from "../types.ts";

/**
 * Anything the provider sent for a session: a `session/update`, or a request from the agent to the
 * client. Permission requests are reported when they start and when they are answered.
 */
export type ProviderOutput =
  | { readonly kind: "update"; readonly sessionId: string | null; readonly activity?: ActivityEvent }
  | { readonly kind: "request" | "permission_started" | "permission_ended"; readonly sessionId: string | null };

export type OutputListener = (output: ProviderOutput) => void;

/** What a running operation is waiting on. */
export type OperationStage = "waiting" | "streaming" | "tool_running" | "awaiting_permission" | "cancelling";

export type SupervisedOperationKind = "turn" | "internal_inference" | "recap";

export type CancelReason = "interrupt" | "steer" | "stalled" | "stop" | "abort";

/**
 * How a requested cancel ended: the provider stopped (`acknowledged`), the process was killed
 * (`forced`), the operation finished on its own first (`too_late`), or it failed with another error.
 */
export type CancelOutcome = "acknowledged" | "forced" | "too_late" | "failed";

/** The readable state of one running operation. Contains no content. */
export interface OperationActivity {
  readonly operationId: string;
  readonly kind: SupervisedOperationKind;
  readonly stage: OperationStage;
  readonly startedAt: number;
  readonly lastOutputAt: number | null;
  readonly toolsInFlight: number;
  readonly cancel?: { readonly reason: CancelReason; readonly requestedAt: number };
}

/** When an operation counts as stale. `false` disables a condition. */
export interface StaleLimits {
  /** No output at all since the request was sent. Default 120 000. */
  readonly firstOutputMs?: number | false;
  /** No output since the last one, with no tool or permission explaining it. Default 180 000. */
  readonly nextOutputMs?: number | false;
  /** One tool running longer than this. Off by default. */
  readonly toolMs?: number | false;
}

/** Stale limits per operation kind. */
export interface OperationLifecycleConfig {
  readonly turns?: StaleLimits;
  readonly internalInference?: StaleLimits;
  readonly recap?: StaleLimits;
}
