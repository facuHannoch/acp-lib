import type { ModelContextBudget } from "../contracts/config-permissions.ts";
import type { ContextBudgetMeasurement } from "../contracts/context.ts";

export const MAX_MODEL_REQUEST_BYTES = 64 * 1024 * 1024;

export function effectiveContextBudget(profile: ModelContextBudget) {
  const outputReserveTokens = Math.max(profile.outputReserveTokens ?? profile.maxOutputTokens ?? 2048, profile.maxOutputTokens ?? 0);
  const estimationMarginTokens = profile.estimationMarginTokens ?? 1024;
  return {
    contextWindowTokens: profile.contextWindowTokens,
    outputReserveTokens,
    estimationMarginTokens,
    inputBudgetTokens: profile.contextWindowTokens - outputReserveTokens - estimationMarginTokens,
    maxRequestBytes: profile.maxRequestBytes ?? MAX_MODEL_REQUEST_BYTES,
  };
}

export function exceededContextBudget(budget: ContextBudgetMeasurement) {
  if (budget.estimatedInputTokens > budget.inputBudgetTokens) return { limit: "input_tokens", budget } as const;
  if (budget.requestBytes > budget.maxRequestBytes) return { limit: "request_bytes", budget } as const;
}
