import type { InternalInferenceRuntime } from "./contracts.ts";

export type InternalInferenceRetention = "all" | { readonly retain: number };

export interface InternalInferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: readonly number[];
}

export interface InternalInferenceConfig {
  readonly runtime?: InternalInferenceRuntime;
  readonly adapter?: "same" | string;
  readonly maxConcurrency?: number;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly retry?: Partial<InternalInferenceRetryPolicy>;
  readonly retention?: InternalInferenceRetention;
}

export interface ResolvedInternalInferenceConfig {
  readonly runtime?: InternalInferenceRuntime;
  readonly adapter: "same" | string;
  readonly maxConcurrency: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly retry: InternalInferenceRetryPolicy;
  readonly retention: InternalInferenceRetention;
}

export function resolveInternalInferenceConfig(
  config: InternalInferenceConfig = {},
): ResolvedInternalInferenceConfig {
  const leaseDurationMs = integer(config.leaseDurationMs ?? 30_000, 1_000, "leaseDurationMs");
  const heartbeatIntervalMs = integer(
    config.heartbeatIntervalMs ?? 10_000,
    250,
    "heartbeatIntervalMs",
  );
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error("internal inference heartbeatIntervalMs must be shorter than leaseDurationMs");
  }
  const maxAttempts = integer(config.retry?.maxAttempts ?? 3, 1, "retry.maxAttempts");
  const backoffMs = config.retry?.backoffMs ?? [1_000, 10_000, 60_000];
  if (backoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("internal inference retry.backoffMs must contain non-negative integers");
  }
  const retention = config.retention ?? "all";
  if (retention !== "all") integer(retention.retain, 0, "retention.retain");
  return Object.freeze({
    ...(config.runtime ? { runtime: config.runtime } : {}),
    adapter: config.adapter ?? "same",
    maxConcurrency: integer(config.maxConcurrency ?? 1, 1, "maxConcurrency"),
    leaseDurationMs,
    heartbeatIntervalMs,
    shutdownGraceMs: integer(config.shutdownGraceMs ?? 2_000, 0, "shutdownGraceMs"),
    retry: Object.freeze({ maxAttempts, backoffMs: Object.freeze([...backoffMs]) }),
    retention,
  });
}

function integer(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`internal inference ${name} must be an integer >= ${minimum}`);
  }
  return value;
}
