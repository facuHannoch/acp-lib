import { afterAll, describe, expect, test } from "bun:test";
import { createLiveModelsDevResolver, fetchLiveCatalog } from "../src/metering/catalog/live.ts";
import { createModelsDevResolver } from "../src/metering/catalog/index.ts";
import { pricingCapturedAt } from "../src/metering/pricing.ts";
import type { PricingContext, PricingPolicy } from "../src/metering/pricing.ts";

/** A models.dev-shaped payload, trimmed to the providers the library has conventions for. */
const PAYLOAD = {
  "opencode-go": {
    id: "opencode-go",
    models: {
      "kimi-k2.6": {
        id: "kimi-k2.6",
        last_updated: "2026-05-21",
        cost: { input: 0.95, output: 4, cache_read: 0.16 },
      },
      "no-price": { id: "no-price" },
    },
  },
  anthropic: { id: "anthropic", models: {} },
  opencode: { id: "opencode", models: {} },
  openai: { id: "openai", models: {} },
};

let requestCount = 0;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fail") return new Response("nope", { status: 503 });
    requestCount += 1;
    return Response.json(PAYLOAD);
  },
});
const base = `http://localhost:${server.port}`;

afterAll(() => server.stop(true));

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    scope: "operation",
    agentSessionId: "a",
    internalSessionId: null,
    operationId: "o",
    adapterId: "opencode",
    providerId: "opencode-go",
    model: "kimi-k2.6",
    operationKind: "prompt",
    at: Date.now(),
    ...overrides,
  };
}

describe("live models.dev resolver", () => {
  test("fetches and builds a valid policy", async () => {
    const resolve = createLiveModelsDevResolver({ url: `${base}/api.json` });
    const policy = (await resolve(context())) as PricingPolicy | null;
    expect(policy).not.toBeNull();
    expect(policy!.providerId).toBe("opencode-go");
    expect(policy!.schedules[0]!.input.amount).toBe("0.95");
  });

  test("applies the same conventions as the pinned build", async () => {
    // The transform is shared, so a live policy must be identical to the pinned one for a
    // model whose upstream prices have not changed. A second implementation here would be
    // a second set of conventions to drift.
    const live = (await createLiveModelsDevResolver({ url: `${base}/api.json` })(
      context(),
    )) as PricingPolicy;
    const pinned = createModelsDevResolver()(context()) as PricingPolicy;
    expect(live.schedules).toEqual(pinned.schedules);
    expect(live.categoryApplicability).toEqual(pinned.categoryApplicability);
  });

  test("engraves a digest of the prices it actually used", async () => {
    // Reproducibility is traded away by fetching live; being able to tell WHICH prices a
    // record used is what keeps the trade honest.
    const policy = (await createLiveModelsDevResolver({ url: `${base}/api.json` })(
      context(),
    )) as PricingPolicy;
    expect(policy.source.kind).toBe("models.dev_live");
    if (policy.source.kind !== "models.dev_live") return;
    expect(policy.source.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("records when the prices were fetched", async () => {
    const before = Date.now();
    const policy = (await createLiveModelsDevResolver({ url: `${base}/api.json`, ttlMs: 0 })(
      context(),
    )) as PricingPolicy;
    expect(policy.source.kind).toBe("models.dev_live");
    if (policy.source.kind !== "models.dev_live") return;
    expect(policy.source.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(pricingCapturedAt(policy.source)).toBe(policy.source.fetchedAt);
  });

  test("surfaces how current the DATA is, not just when it was fetched", async () => {
    // A catalog fetched a second ago can still carry a year-old price, so the two dates
    // answer different questions.
    const policy = (await createLiveModelsDevResolver({ url: `${base}/api.json` })(
      context(),
    )) as PricingPolicy;
    expect(policy.modelLastUpdated).toBe("2026-05-21");
  });

  test("does not claim an upstream commit it never verified", async () => {
    const policy = (await createLiveModelsDevResolver({ url: `${base}/api.json` })(
      context(),
    )) as PricingPolicy;
    // `kind: "models.dev"` promises a pinned commit; a live fetch has resolved none.
    expect(policy.source).not.toHaveProperty("commit");
  });

  test("caches within the TTL so a busy session fetches once", async () => {
    const before = requestCount;
    const resolve = createLiveModelsDevResolver({ url: `${base}/api.json` });
    await Promise.all([resolve(context()), resolve(context()), resolve(context())]);
    await resolve(context());
    // Concurrent callers share one in-flight request rather than each pulling the catalog.
    expect(requestCount - before).toBe(1);
  });

  test("refetches after the TTL expires", async () => {
    const before = requestCount;
    const resolve = createLiveModelsDevResolver({ url: `${base}/api.json`, ttlMs: 0 });
    await resolve(context());
    await resolve(context());
    expect(requestCount - before).toBe(2);
  });

  test("unknown provider and model resolve to null, never a guess", async () => {
    const resolve = createLiveModelsDevResolver({ url: `${base}/api.json` });
    expect(await resolve(context({ providerId: "nope" }))).toBeNull();
    expect(await resolve(context({ model: "nope" }))).toBeNull();
    expect(await resolve(context({ providerId: null }))).toBeNull();
    expect(await resolve(context({ model: null }))).toBeNull();
  });

  test("a model with no prices is unavailable rather than free", async () => {
    const resolve = createLiveModelsDevResolver({ url: `${base}/api.json` });
    expect(await resolve(context({ model: "no-price" }))).toBeNull();
  });

  describe("fetch failure", () => {
    test("defaults to unpriced so best-effort metering keeps recording tokens", async () => {
      const resolve = createLiveModelsDevResolver({ url: `${base}/fail` });
      expect(await resolve(context())).toBeNull();
    });

    test("can throw instead, which a strict mode turns into a preflight rejection", async () => {
      const resolve = createLiveModelsDevResolver({
        url: `${base}/fail`,
        onFetchError: "throw",
      });
      await expect(resolve(context())).rejects.toThrow(/503/);
    });

    test("a failure is not cached as an empty catalog", async () => {
      const resolve = createLiveModelsDevResolver({ url: `${base}/fail`, onFetchError: "throw" });
      await expect(resolve(context())).rejects.toThrow();
      // A second call retries rather than serving a poisoned cache entry.
      await expect(resolve(context())).rejects.toThrow();
    });
  });
});

describe("fetchLiveCatalog", () => {
  test("returns the same readable shape as the pinned catalog", async () => {
    const live = await fetchLiveCatalog({ url: `${base}/api.json` });
    expect(live.source.kind).toBe("models.dev_live");
    const entry = live.get("opencode-go", "kimi-k2.6");
    expect(entry?.schedules[0]!.input.amount).toBe("0.95");
    expect(entry?.modelLastUpdated).toBe("2026-05-21");
    expect(live.entries("opencode-go").map((e) => e.modelId)).toEqual(["kimi-k2.6"]);
  });

  test("surfaces a fetch failure rather than returning an empty catalog", async () => {
    // An empty catalog would read as "nothing is priceable", which is a different and
    // much quieter failure than "the catalog could not be fetched".
    await expect(fetchLiveCatalog({ url: `${base}/fail` })).rejects.toThrow(/503/);
  });
});
