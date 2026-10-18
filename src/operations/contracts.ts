import type { ActivityEvent } from "../types.ts";
export type ProviderOutput =
  | { readonly kind: "update"; readonly sessionId: string | null; readonly activity?: ActivityEvent }
  | { readonly kind: "request" | "permission_started" | "permission_ended"; readonly sessionId: string | null };
export type OutputListener = (output: ProviderOutput) => void;
export type OperationStage = "waiting" | "streaming" | "tool_running" | "awaiting_permission" | "cancelling";
export type SupervisedOperationKind = "turn" | "internal_inference" | "recap";
export type CancelReason = "interrupt" | "steer" | "stalled" | "stop" | "abort";
export interface OperationActivity {
  readonly operationId: string;
  readonly kind: SupervisedOperationKind;
  readonly stage: OperationStage;
  readonly startedAt: number;
  readonly lastOutputAt: number | null;
  readonly toolsInFlight: number;
  readonly cancel?: { readonly reason: CancelReason; readonly requestedAt: number };
}
export interface StaleLimits {
  readonly firstOutputMs?: number | false;
  readonly nextOutputMs?: number | false;
  readonly toolMs?: number | false;
}
export interface OperationLifecycleConfig {
  readonly turns?: StaleLimits;
  readonly internalInference?: StaleLimits;
  readonly recap?: StaleLimits;
}
