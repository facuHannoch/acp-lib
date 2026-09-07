// The shared transform from raw models.dev data into the library's pricing shape.
//
// Lives in src/, not in the generator, because BOTH the pinned artifact and the optional
// live resolver must produce byte-identical policies. When these rules lived only in the
// build script there was no way to fetch fresh prices without reimplementing them, and a
// second implementation is a second set of conventions to drift.
//
// The cache and thought conventions are the part models.dev cannot supply: it publishes
// prices, not counter semantics. A provider is emitted ONLY when its convention is backed
// by evidence recorded below — guessing double-counts cached input or reasoning.

import { decimalFromNumber } from "../money.ts";

/** models.dev publishes every price per one million tokens. */
export const PER_TOKENS = 1_000_000;
/** models.dev does not carry a currency; its prices are USD. */
export const CURRENCY = "USD";

export type Applicability = "applicable" | "not_applicable" | "unknown";

export interface ProviderConvention {
  readonly cacheInputConvention: {
    readonly cachedRead: "included_in_input" | "excluded_from_input";
    readonly cachedWrite: "included_in_input" | "excluded_from_input";
  };
  /** Why we believe the above. Copied into the artifact so it is auditable. */
  readonly evidence: string;
  /** Applicability for categories the price table cannot settle on its own. */
  readonly thought: Applicability;
  /**
   * How reasoning tokens are charged when the catalog carries no separate price.
   * Omit when it is genuinely unknown — an unpriced reported category then makes rating
   * unavailable, which is the honest default.
   */
  readonly thoughtWithoutPrice?: "billed_as_output";
}

/**
 * Documented counter conventions, keyed by models.dev provider id.
 *
 * These describe the PROVIDER's own reporting. §7 notes the convention can also vary by
 * harness normalization path; the real-harness matrix validates that per adapter and may
 * add adapter-level overrides on top of these defaults.
 */
export const OPENCODE_CONVENTION: ProviderConvention = {
  cacheInputConvention: {
    cachedRead: "excluded_from_input",
    cachedWrite: "excluded_from_input",
  },
  evidence:
    "Measured on opencode ACP: totalTokens equals the exact sum of inputTokens, " +
    "outputTokens, cachedReadTokens and thoughtTokens within each single report, across " +
    "five underlying providers. Reasoning is billed at the output rate, reconciled " +
    "exactly against OpenCode's own reported cost on opencode-go/kimi-k2.6.",
  // Reasoning is reported separately but charged as output, so it is always priceable.
  thought: "applicable",
  thoughtWithoutPrice: "billed_as_output",
};

export const CONVENTIONS: Readonly<Record<string, ProviderConvention>> = {
  anthropic: {
    cacheInputConvention: {
      cachedRead: "excluded_from_input",
      cachedWrite: "excluded_from_input",
    },
    evidence:
      "Anthropic Messages API reports cache_read_input_tokens and " +
      "cache_creation_input_tokens as counters separate from input_tokens; total input " +
      "is their sum.",
    // Extended-thinking tokens are billed as output tokens and are not reported as a
    // separate counter. Pricing a thought category would double-count them, so a harness
    // that reports one against an Anthropic route is contradictory evidence (§7) and
    // invalidates the record rather than silently inflating it.
    thought: "not_applicable",
  },
  // OpenCode's gateways. They multiplex many upstream providers but NORMALIZE the
  // counters themselves, so the convention is a property of OpenCode, not of the model
  // behind it — which is what makes one entry legitimate for all of a gateway's models.
  //
  // Measured, not assumed. Across five underlying providers (big-pickle, Ling, MiMo,
  // Nemotron via Zen; Kimi via Go), ten consecutive reports every one satisfied
  //   totalTokens === inputTokens + outputTokens + cachedReadTokens + thoughtTokens
  // within a single report. Disjoint terms mean cache is excluded from input and thought
  // is excluded from output.
  //
  // Reasoning is billed at the OUTPUT rate. Reconciled against OpenCode's own reported
  // cumulative cost on opencode-go/kimi-k2.6, which prices no `reasoning` category:
  //   turn 1  in 2475, out 3, cache 6144, thought 35  ->  computed 0.00348629
  //                                                      reported 0.00348629
  //   turn 2  in  443, out 3, cache 8192, thought 26  ->  computed 0.00184757
  //                                                 reported delta 0.00184757
  // The residual after pricing input/output/cache implied exactly 4.00 per 1M for
  // thought, which is that model's output rate to the digit.
  // See .res/somelogs.md/9-5+/9-6-harness-matrix-findings.md, Findings 5-8.
  opencode: OPENCODE_CONVENTION,
  "opencode-go": OPENCODE_CONVENTION,
  openai: {
    cacheInputConvention: {
      cachedRead: "included_in_input",
      cachedWrite: "included_in_input",
    },
    evidence:
      "OpenAI usage.prompt_tokens includes cached input; cached tokens are itemized " +
      "under prompt_tokens_details.cached_tokens rather than counted separately.",
    thought: "unknown",
  },
};

export interface RawCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  tiers?: ReadonlyArray<
    RawCost & { tier?: { type?: string; size?: number } }
  >;
}

export interface RawModel {
  id?: string;
  name?: string;
  /** ISO date the upstream entry was last changed, e.g. "2026-03-13". */
  last_updated?: string;
  cost?: RawCost;
}

export interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

export function toUnitPrice(value: number | undefined, label: string): { amount: string; currency: string; perTokens: number } | null {
  if (value === undefined || value === null) return null;
  const decimal = decimalFromNumber(value);
  if (!decimal.ok) {
    throw new Error(`${label}: ${decimal.reason}`);
  }
  return { amount: decimal.value, currency: CURRENCY, perTokens: PER_TOKENS };
}

/** Build one schedule from a cost block. Returns null when input/output are unpriced. */
export function buildSchedule(
  cost: RawCost,
  convention: ProviderConvention,
  tier: string,
  conditions: ReadonlyArray<Record<string, unknown>>,
  label: string,
) {
  const input = toUnitPrice(cost.input, `${label}.input`);
  const output = toUnitPrice(cost.output, `${label}.output`);
  // Input and output are mandatory: a schedule that cannot price the two universal
  // categories is not a usable schedule, and a missing price is never zero.
  if (!input || !output) return null;

  const cachedRead = toUnitPrice(cost.cache_read, `${label}.cache_read`);
  const cachedWrite = toUnitPrice(cost.cache_write, `${label}.cache_write`);
  const thought = toUnitPrice(cost.reasoning, `${label}.reasoning`);

  // A model with its own reasoning price uses it; otherwise the provider convention says
  // whether reasoning rides the output rate, and silence means we refuse to guess.
  const thoughtConvention = thought
    ? "separate_price"
    : convention.thoughtWithoutPrice ?? undefined;

  return {
    tier,
    conditions,
    cacheInputConvention: convention.cacheInputConvention,
    ...(thoughtConvention ? { thoughtConvention } : {}),
    input,
    output,
    ...(cachedRead ? { cachedRead } : {}),
    ...(cachedWrite ? { cachedWrite } : {}),
    ...(thought ? { thought } : {}),
  };
}

/**
 * Applicability is a property of the provider/model, not of a pricing tier, so it sits on
 * the policy beside the schedules.
 *
 * A missing price is NOT evidence of inapplicability (§7): it stays "unknown" so the
 * resolver refuses rather than silently omitting a category from cost. Only the
 * convention table may assert "not_applicable".
 */
export function buildApplicability(
  cost: RawCost,
  convention: ProviderConvention,
): Record<string, Applicability> {
  return {
    input: "applicable",
    output: "applicable",
    cached_read: cost.cache_read !== undefined ? "applicable" : "unknown",
    cached_write: cost.cache_write !== undefined ? "applicable" : "unknown",
    thought:
      cost.reasoning !== undefined || convention.thoughtWithoutPrice
        ? "applicable"
        : convention.thought,
  };
}


/**
 * Build the catalog object from raw models.dev data.
 *
 * Deterministic and pure: the same input always produces the same object, which is what
 * lets the artifact be identified by a digest of its serialization.
 */
export function buildCatalog(raw: Record<string, RawProvider>): {
  catalog: {
    currency: string;
    perTokens: number;
    providers: Record<string, unknown>;
  };
  modelCount: number;
  skippedCount: number;
} {
  const providers: Record<string, unknown> = {};
  let modelCount = 0;
  let skippedCount = 0;

  for (const [providerId, convention] of Object.entries(CONVENTIONS)) {
    const source = raw[providerId];
    if (!source) throw new Error(`provider ${providerId} is absent from models.dev`);

    const models: Record<string, unknown> = {};
    for (const [modelId, model] of Object.entries(source.models ?? {})) {
      const cost = model.cost;
      if (!cost) {
        skippedCount += 1;
        continue;
      }
      const label = `${providerId}/${modelId}`;
      const schedules = [buildSchedule(cost, convention, "default", [{ kind: "default" }], label)];

      // A context tier becomes a second schedule selected by an explicit condition, so
      // long-context pricing is a recorded decision rather than a hidden multiplier.
      for (const tier of cost.tiers ?? []) {
        const size = tier.tier?.size;
        if (tier.tier?.type !== "context" || !Number.isSafeInteger(size) || (size as number) <= 0) {
          continue;
        }
        schedules.push(
          buildSchedule(
            tier,
            convention,
            `context_over_${size}`,
            [{ kind: "context_tokens_at_least", tokens: size }],
            `${label}#${size}`,
          ),
        );
      }

      const usable = schedules.filter((schedule) => schedule !== null);
      if (usable.length === 0) {
        skippedCount += 1;
        continue;
      }
      models[modelId] = {
        categoryApplicability: buildApplicability(cost, convention),
        // How current the DATA is, as opposed to when we captured it.
        ...(typeof model.last_updated === "string" && model.last_updated
          ? { lastUpdated: model.last_updated }
          : {}),
        schedules: usable,
      };
      modelCount += 1;
    }

    providers[providerId] = {
      cacheInputConvention: convention.cacheInputConvention,
      conventionEvidence: convention.evidence,
      models,
    };
  }

  return { catalog: { currency: CURRENCY, perTokens: PER_TOKENS, providers }, modelCount, skippedCount };
}

/** Stable serialization: 2-space indent plus a trailing newline. The digest covers this. */
export function serializeCatalog(catalog: unknown): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
