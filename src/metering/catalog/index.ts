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

export interface CatalogModel {
  readonly categoryApplicability: Readonly<Record<string, string>>;
  readonly lastUpdated?: string;
  readonly schedules: readonly PricingSchedule[];
}

export interface CatalogProvider {
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

/** One priceable model, with everything needed to display or re-derive its rates. */
export interface CatalogEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** ISO date the upstream entry last changed, when the source records it. */
  readonly modelLastUpdated?: string;
  readonly categoryApplicability: Readonly<Record<TokenCategory, CategoryApplicability>>;
  readonly schedules: readonly PricingSchedule[];
}

export interface CatalogProviderInfo {
  readonly providerId: string;
  readonly cacheInputConvention: CacheInputConvention;
  /** Why the library believes that convention — auditable, not folklore. */
  readonly conventionEvidence: string;
  readonly modelCount: number;
}

/**
 * A readable view of a pricing catalog.
 *
 * The resolver answers "what does THIS model cost"; this answers "what can you price, and
 * at what rates" — needed to build a price list, a model picker, or a markup table without
 * reaching into the library's files.
 */
export interface PricingCatalog {
  readonly source: PricingSource;
  readonly providers: readonly CatalogProviderInfo[];
  /** Every priceable model, or just one provider's. */
  entries(providerId?: string): readonly CatalogEntry[];
  get(providerId: string, modelId: string): CatalogEntry | null;
}

/**
 * Wrap raw catalog providers in the readable view.
 *
 * Shared with the live resolver so both catalogs expose exactly the same surface.
 */
export function makeCatalog(
  providers: Readonly<Record<string, CatalogProvider>>,
  source: PricingSource,
): PricingCatalog {
  const toEntry = (providerId: string, modelId: string, model: CatalogModel): CatalogEntry =>
    Object.freeze({
      providerId,
      modelId,
      ...(model.lastUpdated ? { modelLastUpdated: model.lastUpdated } : {}),
      categoryApplicability: model.categoryApplicability as Readonly<
        Record<TokenCategory, CategoryApplicability>
      >,
      schedules: model.schedules,
    });

  return Object.freeze({
    source,
    providers: Object.freeze(
      Object.entries(providers).map(([providerId, provider]) =>
        Object.freeze({
          providerId,
          cacheInputConvention: provider.cacheInputConvention,
          conventionEvidence: provider.conventionEvidence,
          modelCount: Object.keys(provider.models).length,
        }),
      ),
    ),
    entries(providerId?: string) {
      const wanted = providerId ? { [providerId]: providers[providerId] } : providers;
      const out: CatalogEntry[] = [];
      for (const [id, provider] of Object.entries(wanted)) {
        if (!provider) continue;
        for (const modelId of Object.keys(provider.models).sort()) {
          out.push(toEntry(id, modelId, provider.models[modelId]!));
        }
      }
      return Object.freeze(out);
    },
    get(providerId: string, modelId: string) {
      const model = providers[providerId]?.models[modelId];
      return model ? toEntry(providerId, modelId, model) : null;
    },
  });
}

/**
 * The pinned catalog the library ships, as a readable view.
 *
 * Verifies the artifact digest first, so a listing cannot show prices the library would
 * refuse to rate with.
 */
export function loadPinnedCatalog(): PricingCatalog {
  verifyCatalogIntegrity();
  return makeCatalog(catalog.providers, MODELS_DEV_SOURCE);
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
      ...(entry.lastUpdated ? { modelLastUpdated: entry.lastUpdated } : {}),
      schedules: entry.schedules,
    };

    // A catalog entry that cannot satisfy the policy invariants is unavailable, not
    // partially usable: half a schedule silently drops real cost from the total.
    return validatePricingPolicy(policy).ok ? policy : null;
  };
}
