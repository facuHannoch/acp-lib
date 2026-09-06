// The pinned models.dev catalog resolver — the library's DEFAULT pricing source.
// See 9-6-SPEC-metering.md §7.
//
// This is an offline deterministic default, not an always-current catalog and not a
// provider billing authority. It exists so a consumer gets reproducible rated costs
// without shipping their own price table, and so every record can name the exact upstream
// commit and artifact digest its prices came from.
//
// Regenerate with: bun run scripts/generate-pricing-catalog.ts

import { createHash } from "node:crypto";
import catalogJson from "./models-dev.catalog.json" with { type: "json" };
import metaJson from "./models-dev.meta.json" with { type: "json" };
import type {
  CacheInputConvention,
  CategoryApplicability,
  PricingContext,
  PricingPolicy,
  PricingResolver,
  PricingSchedule,
  PricingSource,
  TokenCategory,
} from "../pricing.ts";
import { validatePricingPolicy } from "../pricing.ts";

interface CatalogModel {
  readonly categoryApplicability: Readonly<Record<string, string>>;
  readonly schedules: readonly PricingSchedule[];
}

interface CatalogProvider {
  readonly cacheInputConvention: CacheInputConvention;
  readonly conventionEvidence: string;
  readonly models: Readonly<Record<string, CatalogModel>>;
}

interface Catalog {
  readonly currency: string;
  readonly perTokens: number;
  readonly providers: Readonly<Record<string, CatalogProvider>>;
}

const catalog = catalogJson as unknown as Catalog;

/** Identity of the shipped artifact, engraved into every policy it produces. */
export const MODELS_DEV_SOURCE: PricingSource = Object.freeze({
  kind: "models.dev",
  commit: metaJson.commit,
  artifactSha256: metaJson.artifactSha256,
  generatedAt: metaJson.generatedAt,
});

let integrityChecked = false;

/**
 * Verify the shipped catalog against the digest recorded beside it.
 *
 * The digest is what makes `artifactSha256` in a stored record meaningful: without this
 * check the field would assert an identity nobody confirmed. Runs once, lazily — hashing
 * ~76 KiB on first pricing call is cheaper than being wrong about which prices shipped.
 */
export function verifyCatalogIntegrity(): void {
  if (integrityChecked) return;
  // Must reproduce the generator's serialization exactly: 2-space indent, trailing newline.
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (digest !== metaJson.artifactSha256) {
    throw new Error(
      `pricing catalog digest mismatch: artifact hashes to ${digest} but its metadata ` +
        `records ${metaJson.artifactSha256}. Regenerate with ` +
        `scripts/generate-pricing-catalog.ts.`,
    );
  }
  integrityChecked = true;
}

/** Providers this catalog can price, i.e. those with a documented counter convention. */
export function catalogProviderIds(): readonly string[] {
  return Object.freeze(Object.keys(catalog.providers));
}

/**
 * Build the default resolver.
 *
 * Returns null — never a guess — when the provider or model is not matched exactly. §7
 * forbids inferring a provider from a bare model string: two providers can serve the same
 * model id at different prices, so a fuzzy match would engrave a plausible wrong number
 * rather than an honest "unavailable".
 */
export function createModelsDevResolver(): PricingResolver {
  return (context: PricingContext): PricingPolicy | null => {
    verifyCatalogIntegrity();

    const { providerId, model } = context;
    if (!providerId || !model) return null;

    const provider = catalog.providers[providerId];
    if (!provider) return null;

    const entry = provider.models[model];
    if (!entry) return null;

    const policy: PricingPolicy = {
      source: MODELS_DEV_SOURCE,
      providerId,
      modelId: model,
      categoryApplicability: entry.categoryApplicability as Readonly<
        Record<TokenCategory, CategoryApplicability>
      >,
      schedules: entry.schedules,
    };

    // A catalog entry that cannot satisfy the policy invariants is unavailable, not
    // partially usable: half a schedule silently drops real cost from the total.
    return validatePricingPolicy(policy).ok ? policy : null;
  };
}
