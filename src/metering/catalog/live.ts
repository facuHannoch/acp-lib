// An optional live models.dev pricing resolver. See 9-6-SPEC-metering.md §7.
//
// The DEFAULT is the pinned artifact, and that is the right default: models.dev publishes
// no versioning scheme and no update-frequency guarantee, so a live fetch means the price
// applied to an operation depends on when it ran. This exists for consumers who would
// rather have current prices than reproducible ones — a legitimate trade, but a trade.
//
// What makes it defensible is that a record still carries WHICH prices it used. Every
// policy this produces engraves the SHA-256 of the exact payload it was built from, so two
// records rated days apart are distinguishable, and an unexpected price change is
// detectable after the fact rather than invisible.
//
// It is never automatic. `MeteringConfig.pricing` must be set to it explicitly.

import { createHash } from "node:crypto";
import {
  buildCatalog,
  serializeCatalog,
  type RawProvider,
} from "./build.ts";
import type {
  CategoryApplicability,
  PricingContext,
  PricingPolicy,
  PricingResolver,
  PricingSchedule,
  PricingSource,
  TokenCategory,
} from "../pricing.ts";
import { validatePricingPolicy } from "../pricing.ts";

const CATALOG_URL = "https://models.dev/api.json";
/** Long enough that a busy session makes one request; short enough to be "live". */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface LiveCatalogOptions {
  /** Milliseconds a fetched catalog is reused. Default 15 minutes. */
  readonly ttlMs?: number;
  /** Override the endpoint, e.g. for an internal mirror. */
  readonly url?: string;
  /**
   * What to do when the fetch fails.
   *
   * `"unpriced"` (default) returns null, so best-effort metering records real tokens with
   * no price rather than stalling. `"throw"` surfaces the failure, which a strict mode
   * turns into a preflight rejection before any provider work is dispatched.
   */
  readonly onFetchError?: "unpriced" | "throw";
}

interface CachedCatalog {
  readonly providers: Record<string, { models: Record<string, unknown> }>;
  readonly source: PricingSource;
  readonly fetchedAt: number;
}

interface CatalogModel {
  readonly categoryApplicability: Readonly<Record<string, string>>;
  readonly lastUpdated?: string;
  readonly schedules: readonly PricingSchedule[];
}

/**
 * Build a resolver that fetches models.dev on demand.
 *
 * The transform is the one shared with the build script, so a live policy is identical to
 * the pinned one for any model whose upstream prices have not changed.
 */
export function createLiveModelsDevResolver(options: LiveCatalogOptions = {}): PricingResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const url = options.url ?? CATALOG_URL;
  const onFetchError = options.onFetchError ?? "unpriced";

  let cached: CachedCatalog | null = null;
  // One in-flight request shared by concurrent operations: a queue of prompts starting
  // together must not each fetch several hundred KiB.
  let inFlight: Promise<CachedCatalog | null> | null = null;

  async function load(): Promise<CachedCatalog | null> {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
        const payload = await response.text();
        const raw = JSON.parse(payload) as Record<string, RawProvider>;
        const { catalog } = buildCatalog(raw);

        // Digest the SERIALIZED catalog, not the raw payload: it is the thing that
        // determines prices, and it matches how the pinned artifact is identified.
        const artifactSha256 = createHash("sha256")
          .update(serializeCatalog(catalog), "utf8")
          .digest("hex");

        cached = {
          providers: catalog.providers as CachedCatalog["providers"],
          // Not `kind: "models.dev"`: that shape promises an upstream commit, and a
          // live fetch has verified none. The digest and the fetch time are what this run
          // can honestly assert about the prices it used.
          source: Object.freeze({
            kind: "models.dev_live",
            artifactSha256,
            fetchedAt: Date.now(),
          }),
          fetchedAt: Date.now(),
        };
        return cached;
      } catch (err) {
        if (onFetchError === "throw") throw err;
        return null;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  return async (context: PricingContext): Promise<PricingPolicy | null> => {
    const { providerId, model } = context;
    if (!providerId || !model) return null;

    const catalog = await load();
    if (!catalog) return null;

    const entry = catalog.providers[providerId]?.models[model] as CatalogModel | undefined;
    if (!entry) return null;

    const policy: PricingPolicy = {
      source: catalog.source,
      providerId,
      modelId: model,
      categoryApplicability: entry.categoryApplicability as Readonly<
        Record<TokenCategory, CategoryApplicability>
      >,
      ...(entry.lastUpdated ? { modelLastUpdated: entry.lastUpdated } : {}),
      schedules: entry.schedules,
    };
    return validatePricingPolicy(policy).ok ? policy : null;
  };
}
