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

/**
 * How a harness's ACP token counters should be read.
 *
 * ACP does not say. The SDK documents `PromptResponse.usage` as usage "for this turn"
 * while documenting the `Usage` fields as totals across the session, and exposes no
 * discriminator — so this is adapter- and version-scoped EVIDENCE, never a runtime guess.
 * §4 forbids switching interpretations mid-session, because a first report that happens
 * to look like one shape would silently relabel every later record.
 */
export type CounterInterpretation = "cumulative" | "per_turn";

/**
 * Harnesses measured to report per-turn counters.
 *
 * OpenCode: three consecutive turns on opencode/big-pickle each satisfied
 * `totalTokens === inputTokens + outputTokens + cachedReadTokens` within a SINGLE report,
 * and `inputTokens` fell 5897 → 20 between turns. Totals still rose turn over turn
 * (every turn re-reads the same cached context), which is why comparing totals is not a
 * valid test and reported "cumulative" until the components were checked.
 * See .res/somelogs.md/9-5+/9-6-harness-matrix-findings.md, Finding 5.
 */
const PER_TURN_ADAPTERS: ReadonlySet<string> = new Set(["opencode"]);

/**
 * The interpretation to apply for an adapter.
 *
 * Defaults to cumulative — the reading the field-level SDK docs describe and the only one
 * that makes `totalTokens` ("sum of all token types across session") coherent. An adapter
 * is moved out of the default only on measurement.
 */
export function counterInterpretationForAdapter(adapterId: string): CounterInterpretation {
  return PER_TURN_ADAPTERS.has(adapterId) ? "per_turn" : "cumulative";
}
