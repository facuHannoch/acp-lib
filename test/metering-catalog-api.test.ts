import { describe, expect, test } from "bun:test";
import {
  loadPinnedCatalog,
  pricingCapturedAt,
  createModelsDevResolver,
  type CatalogEntry,
} from "../src/index.ts";
import type { PricingPolicy } from "../src/metering/pricing.ts";

const catalog = loadPinnedCatalog();

describe("consumer-facing catalog", () => {
  test("enumerates every priceable model without reaching into library files", () => {
    // The listing tool used to deep-import the catalog JSON, a path no consumer can take —
    // the tool worked while the capability did not exist.
    const entries = catalog.entries();
    expect(entries.length).toBeGreaterThan(150);
    for (const entry of entries.slice(0, 5)) {
      expect(entry.providerId).toBeTruthy();
      expect(entry.modelId).toBeTruthy();
      expect(entry.schedules.length).toBeGreaterThan(0);
    }
  });

  test("filters to one provider", () => {
    const entries = catalog.entries("anthropic");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.providerId === "anthropic")).toBe(true);
    expect(entries.length).toBeLessThan(catalog.entries().length);
  });

  test("an unknown provider yields nothing rather than throwing", () => {
    expect(catalog.entries("not-a-provider")).toEqual([]);
  });

  test("looks up a single model, and returns null for a miss", () => {
    const entry = catalog.get("anthropic", "claude-sonnet-4-5");
    expect(entry?.modelId).toBe("claude-sonnet-4-5");
    expect(catalog.get("anthropic", "nope")).toBeNull();
    expect(catalog.get("nope", "claude-sonnet-4-5")).toBeNull();
  });

  test("carries the dates a consumer needs to judge freshness", () => {
    expect(pricingCapturedAt(catalog.source)).toBeGreaterThan(Date.parse("2024-01-01"));
    const entry = catalog.get("anthropic", "claude-sonnet-4-5")!;
    expect(entry.modelLastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("describes each provider and why its convention is believed", () => {
    // Evidence, not folklore: a consumer can audit why cache is treated as it is.
    for (const provider of catalog.providers) {
      expect(provider.modelCount).toBeGreaterThan(0);
      expect(provider.conventionEvidence.length).toBeGreaterThan(20);
      expect(["included_in_input", "excluded_from_input"]).toContain(
        provider.cacheInputConvention.cachedRead,
      );
    }
    expect(catalog.providers.map((p) => p.providerId)).toContain("opencode-go");
  });

  test("provider model counts agree with the entries listed", () => {
    for (const provider of catalog.providers) {
      expect(catalog.entries(provider.providerId).length).toBe(provider.modelCount);
    }
  });

  test("agrees with the resolver on rates, so a quoted price is the priced one", () => {
    // A price list that disagreed with what gets charged would be worse than none.
    const resolve = createModelsDevResolver();
    const entry = catalog.get("opencode-go", "kimi-k2.6")!;
    const policy = resolve({
      scope: "operation",
      agentSessionId: "-",
      internalSessionId: null,
      operationId: "-",
      adapterId: "opencode",
      providerId: "opencode-go",
      model: "kimi-k2.6",
      operationKind: "prompt",
      at: Date.now(),
    }) as PricingPolicy;
    expect(entry.schedules).toEqual(policy.schedules);
    expect(entry.modelLastUpdated).toBe(policy.modelLastUpdated);
  });

  test("entries are frozen so a consumer cannot mutate the shared catalog", () => {
    const entry: CatalogEntry = catalog.entries("anthropic")[0]!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
  });
});
