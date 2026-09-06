#!/usr/bin/env bun
// Generates the pinned models.dev pricing catalog shipped as the library's default
// pricing source. See 9-6-SPEC-metering.md §7.
//
// Run at release time:  bun run scripts/generate-pricing-catalog.ts
//
// Two properties this script exists to guarantee:
//
//   1. Float never reaches a rated cost. models.dev delivers prices as JSON numbers;
//      they are converted to canonical decimal strings HERE, at build time, so runtime
//      pricing only ever multiplies BigInt-backed decimals.
//
//   2. A record stays reproducible. The artifact is pinned to an immutable upstream
//      commit and identified by its own SHA-256, so "what did this cost" is answerable
//      years later without consulting a mutable catalog.
//
// The cache-input convention is NOT derivable from models.dev — it publishes prices, not
// counter semantics. Guessing it would double-count cached input, so a provider is
// emitted only when its convention is backed by documented evidence in CONVENTIONS
// below. Everything else is omitted, and the default resolver returns null for it rather
// than inventing a price. Add providers as the §20 harness matrix produces evidence.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decimalFromNumber } from "../src/metering/money.ts";

const CATALOG_URL = "https://models.dev/api.json";
const REPO = "anomalyco/models.dev";
const REPO_REF = "dev";
/** models.dev publishes every price per one million tokens. */
const PER_TOKENS = 1_000_000;
/** models.dev does not carry a currency; its prices are USD. */
const CURRENCY = "USD";

const OUT_DIR = join(import.meta.dir, "..", "src", "metering", "catalog");

type Applicability = "applicable" | "not_applicable" | "unknown";

interface ProviderConvention {
  readonly cacheInputConvention: {
    readonly cachedRead: "included_in_input" | "excluded_from_input";
    readonly cachedWrite: "included_in_input" | "excluded_from_input";
  };
  /** Why we believe the above. Copied into the artifact so it is auditable. */
  readonly evidence: string;
  /** Applicability for categories the price table cannot settle on its own. */
  readonly thought: Applicability;
}

/**
 * Documented counter conventions, keyed by models.dev provider id.
 *
 * These describe the PROVIDER's own reporting. §7 notes the convention can also vary by
 * harness normalization path; the real-harness matrix validates that per adapter and may
 * add adapter-level overrides on top of these defaults.
 */
const CONVENTIONS: Readonly<Record<string, ProviderConvention>> = {
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
  // OpenCode's Zen gateway. It multiplexes many upstream providers but NORMALIZES their
  // counters itself, so the convention is a property of OpenCode, not of the model behind
  // it — which is what makes one entry legitimate for all 102 of its models.
  //
  // Measured, not assumed: across four distinct underlying providers (big-pickle, Ling,
  // MiMo, Nemotron), eight consecutive reports every one satisfied
  //   totalTokens === inputTokens + outputTokens + cachedReadTokens + thoughtTokens
  // within a single report. Disjoint terms mean cache is excluded from input and thought
  // is excluded from output, so pricing each separately double-counts nothing.
  // See .res/somelogs.md/9-5+/9-6-harness-matrix-findings.md, Findings 5-6.
  opencode: {
    cacheInputConvention: {
      cachedRead: "excluded_from_input",
      cachedWrite: "excluded_from_input",
    },
    evidence:
      "Measured on opencode ACP: totalTokens equals the exact sum of inputTokens, " +
      "outputTokens, cachedReadTokens and thoughtTokens within each single report, " +
      "across four underlying providers.",
    // Thought is a disjoint term in that identity, so where the catalog prices reasoning
    // it can be charged on its own. Where it does not, applicability stays unknown rather
    // than being asserted either way.
    thought: "unknown",
  },
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

interface RawCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  tiers?: ReadonlyArray<
    RawCost & { tier?: { type?: string; size?: number } }
  >;
}

interface RawModel {
  id?: string;
  name?: string;
  cost?: RawCost;
}

interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

function toUnitPrice(value: number | undefined, label: string): { amount: string; currency: string; perTokens: number } | null {
  if (value === undefined || value === null) return null;
  const decimal = decimalFromNumber(value);
  if (!decimal.ok) {
    throw new Error(`${label}: ${decimal.reason}`);
  }
  return { amount: decimal.value, currency: CURRENCY, perTokens: PER_TOKENS };
}

/** Build one schedule from a cost block. Returns null when input/output are unpriced. */
function buildSchedule(
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

  return {
    tier,
    conditions,
    cacheInputConvention: convention.cacheInputConvention,
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
function buildApplicability(
  cost: RawCost,
  convention: ProviderConvention,
): Record<string, Applicability> {
  return {
    input: "applicable",
    output: "applicable",
    cached_read: cost.cache_read !== undefined ? "applicable" : "unknown",
    cached_write: cost.cache_write !== undefined ? "applicable" : "unknown",
    thought: cost.reasoning !== undefined ? "applicable" : convention.thought,
  };
}

async function main() {
  console.log(`fetching ${CATALOG_URL}`);
  const catalogResponse = await fetch(CATALOG_URL);
  if (!catalogResponse.ok) {
    throw new Error(`models.dev returned ${catalogResponse.status}`);
  }
  const raw = (await catalogResponse.json()) as Record<string, RawProvider>;

  // Resolve the mutable ref to an immutable commit. "Latest" is the input; a fixed SHA
  // is what gets engraved, because that is what makes an old record reproducible.
  const commitResponse = await fetch(
    `https://api.github.com/repos/${REPO}/commits/${REPO_REF}`,
    { headers: { Accept: "application/vnd.github+json" }, redirect: "follow" },
  );
  if (!commitResponse.ok) {
    throw new Error(`GitHub returned ${commitResponse.status} resolving ${REPO}@${REPO_REF}`);
  }
  const commit = ((await commitResponse.json()) as { sha?: string }).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`could not resolve an upstream commit for ${REPO}@${REPO_REF}`);
  }
  console.log(`pinned ${REPO}@${commit}`);

  const providers: Record<string, unknown> = {};
  let modelCount = 0;
  let skippedNoPrice = 0;

  for (const [providerId, convention] of Object.entries(CONVENTIONS)) {
    const source = raw[providerId];
    if (!source) throw new Error(`provider ${providerId} is absent from models.dev`);

    const models: Record<string, unknown> = {};
    for (const [modelId, model] of Object.entries(source.models ?? {})) {
      const cost = model.cost;
      if (!cost) {
        skippedNoPrice += 1;
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

      const usable = schedules.filter((s) => s !== null);
      if (usable.length === 0) {
        skippedNoPrice += 1;
        continue;
      }
      models[modelId] = {
        categoryApplicability: buildApplicability(cost, convention),
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

  const catalog = { currency: CURRENCY, perTokens: PER_TOKENS, providers };
  // Stable key order + trailing newline so the digest is reproducible across runs.
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const artifactSha256 = createHash("sha256").update(catalogJson, "utf8").digest("hex");

  const meta = {
    kind: "models.dev" as const,
    commit,
    artifactSha256,
    generatedAt: Date.now(),
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "models-dev.catalog.json"), catalogJson, "utf8");
  await writeFile(join(OUT_DIR, "models-dev.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  console.log(
    `wrote ${Object.keys(providers).length} providers, ${modelCount} models ` +
      `(${skippedNoPrice} skipped for missing prices)`,
  );
  console.log(`artifact sha256 ${artifactSha256}`);
  console.log(`catalog ${(catalogJson.length / 1024).toFixed(1)} KiB`);
}

await main();
