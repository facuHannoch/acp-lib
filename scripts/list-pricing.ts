#!/usr/bin/env bun
// Print the pinned pricing catalog: what the library can price, and at what rates.
//
// Reads the shipped artifact, not the network, so this is exactly what a record engraved
// today would be rated against — including the catalog identity a stored record carries.
//
// Usage:
//   bun run scripts/list-pricing.ts                    # provider summary
//   bun run scripts/list-pricing.ts opencode-go        # one provider's models
//   bun run scripts/list-pricing.ts --all              # every model
//   bun run scripts/list-pricing.ts --json opencode    # machine-readable

import {
  MODELS_DEV_SOURCE,
  catalogProviderIds,
  createModelsDevResolver,
  verifyCatalogIntegrity,
} from "../src/metering/catalog/index.ts";
import type { PricingPolicy } from "../src/metering/pricing.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const all = args.includes("--all");
const wanted = args.filter((arg) => !arg.startsWith("--"));

verifyCatalogIntegrity();
const resolve = createModelsDevResolver();

const catalog = (await import("../src/metering/catalog/models-dev.catalog.json", {
  with: { type: "json" },
})).default as {
  providers: Record<string, { conventionEvidence: string; models: Record<string, unknown> }>;
};

function policyFor(providerId: string, modelId: string): PricingPolicy | null {
  const policy = resolve({
    scope: "operation",
    agentSessionId: "-",
    internalSessionId: null,
    operationId: "-",
    adapterId: "-",
    providerId,
    model: modelId,
    operationKind: "prompt",
    at: Date.now(),
  });
  return policy instanceof Promise ? null : policy;
}

interface Row {
  provider: string;
  model: string;
  input: string;
  output: string;
  cachedRead: string;
  cachedWrite: string;
  thought: string;
  tiers: string;
}

function rowsFor(providerId: string): Row[] {
  const rows: Row[] = [];
  for (const modelId of Object.keys(catalog.providers[providerId]?.models ?? {}).sort()) {
    const policy = policyFor(providerId, modelId);
    if (!policy) continue;
    const base = policy.schedules.find((s) => s.tier === "default") ?? policy.schedules[0]!;
    const extra = policy.schedules.filter((s) => s.tier !== "default").map((s) => s.tier);
    rows.push({
      provider: providerId,
      model: modelId,
      input: base.input.amount,
      output: base.output.amount,
      cachedRead: base.cachedRead?.amount ?? "—",
      cachedWrite: base.cachedWrite?.amount ?? "—",
      // A model with no separate reasoning price still prices reasoning when the provider
      // bills it as output; showing which is the point.
      thought: base.thought
        ? base.thought.amount
        : base.thoughtConvention === "billed_as_output"
          ? `= output`
          : "—",
      tiers: extra.length > 0 ? extra.join(", ") : "—",
    });
  }
  return rows;
}

const providers = wanted.length > 0 ? wanted : catalogProviderIds();

if (asJson) {
  const out = providers.flatMap(rowsFor);
  process.stdout.write(`${JSON.stringify({ source: MODELS_DEV_SOURCE, models: out }, null, 2)}\n`);
} else {
  const lines: string[] = [""];
  const source = MODELS_DEV_SOURCE;
  lines.push(
    source.kind === "models.dev"
      ? `catalog  models.dev@${source.commit.slice(0, 12)}  sha256:${source.artifactSha256.slice(0, 12)}`
      : `catalog  ${source.kind}`,
    "prices are USD per 1,000,000 tokens",
    "",
  );

  if (wanted.length === 0 && !all) {
    lines.push("PROVIDERS THE LIBRARY CAN PRICE", "");
    for (const providerId of providers) {
      const rows = rowsFor(providerId);
      lines.push(`  ${providerId.padEnd(14)} ${String(rows.length).padStart(4)} models`);
      lines.push(`  ${" ".repeat(14)} ${catalog.providers[providerId]!.conventionEvidence}`);
      lines.push("");
    }
    lines.push("Pass a provider id for its models, or --all for everything.", "");
  } else {
    const rows = (all ? catalogProviderIds() : providers).flatMap(rowsFor);
    const columns: Array<[string, keyof Row]> = [
      ["provider", "provider"],
      ["model", "model"],
      ["input", "input"],
      ["output", "output"],
      ["cache rd", "cachedRead"],
      ["cache wr", "cachedWrite"],
      ["thought", "thought"],
      ["extra tiers", "tiers"],
    ];
    const widths = columns.map(([header, key]) =>
      Math.max(header.length, ...rows.map((row) => String(row[key]).length)),
    );
    lines.push(columns.map(([header], i) => header.padEnd(widths[i]!)).join("  "));
    lines.push(widths.map((width) => "-".repeat(width)).join("  "));
    for (const row of rows) {
      lines.push(columns.map(([, key], i) => String(row[key]).padEnd(widths[i]!)).join("  "));
    }
    lines.push("", `${rows.length} models`, "");
  }
  process.stdout.write(lines.join("\n"));
}
