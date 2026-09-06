// Mapping an adapter to a models.dev provider key, and finding the active model.
// See 9-6-SPEC-metering.md §7.
//
// §7 forbids guessing a provider from a bare model string: two providers can serve the
// same model id at different prices, so a guess engraves a plausible wrong number instead
// of an honest "unavailable". Only single-provider adapters with a tested mapping appear
// here. A multiplexing harness such as OpenCode must report its selected provider through
// a certified integration; until then it resolves to null and stays unpriced.

import type { ConfigOptions } from "../config-options.ts";

const ADAPTER_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  claude: "anthropic",
  claudeCode: "anthropic",
  codex: "openai",
});

/** The models.dev provider key for an adapter, or null when it cannot be established. */
export function providerIdForAdapter(adapterId: string): string | null {
  return ADAPTER_PROVIDERS[adapterId] ?? null;
}

/** Config option ids harnesses use for the active model, in preference order. */
const MODEL_OPTION_IDS = ["model", "model_id", "modelId"] as const;

/**
 * The plain advertised model string from harness config, or null.
 *
 * Discovered, never hardcoded — the library does not know a harness's model catalog, and
 * a stale guess would misprice every record it touched.
 */
export function activeModel(options: ConfigOptions): string | null {
  for (const id of MODEL_OPTION_IDS) {
    const value = options.get(id)?.currentValue;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
