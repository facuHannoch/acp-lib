#!/usr/bin/env bun
// Print the pricing catalog: what the library can price, and at what rates.
//
// Uses only the library's PUBLIC API — the same `loadPinnedCatalog()` / `fetchLiveCatalog()`
// a consumer would call. That is deliberate: it was previously deep-importing the catalog
// JSON, a path no consumer can take, so the tool worked while the capability did not exist.
//
// Usage:
//   bun run pricing:list                      # provider summary (pinned)
//   bun run pricing:list opencode-go          # one provider's models
//   bun run pricing:list --all                # every model
//   bun run pricing:list --live opencode-go   # current upstream prices
//   bun run pricing:list --json opencode      # machine-readable

import {
  fetchLiveCatalog,
  loadPinnedCatalog,
  pricingCapturedAt,
  type CatalogEntry,
  type PricingCatalog,
} from "../src/index.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const all = args.includes("--all");
const live = args.includes("--live");
const wanted = args.filter((arg) => !arg.startsWith("--"));

const catalog: PricingCatalog = live ? await fetchLiveCatalog() : loadPinnedCatalog();

interface Row {
  provider: string;
  model: string;
  input: string;
  output: string;
  cachedRead: string;
  cachedWrite: string;
  thought: string;
  tiers: string;
  updated: string;
}

function toRow(entry: CatalogEntry): Row {
  const base = entry.schedules.find((s) => s.tier === "default") ?? entry.schedules[0]!;
  const extra = entry.schedules.filter((s) => s.tier !== "default").map((s) => s.tier);
  return {
    provider: entry.providerId,
    model: entry.modelId,
    input: base.input.amount,
    output: base.output.amount,
    cachedRead: base.cachedRead?.amount ?? "—",
    cachedWrite: base.cachedWrite?.amount ?? "—",
    // A model with no separate reasoning price is still priceable when the provider bills
    // reasoning as output; showing which is the point.
    thought: base.thought
      ? base.thought.amount
      : base.thoughtConvention === "billed_as_output"
        ? "= output"
        : "—",
    tiers: extra.length > 0 ? extra.join(", ") : "—",
    // When the DATA changed upstream — a different question from when we captured it.
    updated: entry.modelLastUpdated ?? "—",
  };
}

const selected = wanted.length > 0 ? wanted.flatMap((id) => catalog.entries(id)) : catalog.entries();

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ source: catalog.source, models: selected.map(toRow) }, null, 2)}\n`,
  );
} else {
  const source = catalog.source;
  const capturedAt = pricingCapturedAt(source);
  const lines: string[] = [
    "",
    source.kind === "models.dev"
      ? `catalog   models.dev@${source.commit.slice(0, 12)}  sha256:${source.artifactSha256.slice(0, 12)}`
      : source.kind === "models.dev_live"
        ? `catalog   models.dev (live)  sha256:${source.artifactSha256.slice(0, 12)}`
        : `catalog   ${source.kind}`,
    // Two different questions: when we captured the catalog, and when each model's entry
    // last changed upstream. A fresh capture can carry year-old prices.
    `captured  ${capturedAt ? new Date(capturedAt).toISOString() : "unknown"}`,
    "prices are USD per 1,000,000 tokens; 'data updated' is the upstream entry date",
    "",
  ];

  if (wanted.length === 0 && !all) {
    lines.push("PROVIDERS THE LIBRARY CAN PRICE", "");
    for (const provider of catalog.providers) {
      lines.push(`  ${provider.providerId.padEnd(14)} ${String(provider.modelCount).padStart(4)} models`);
      lines.push(`  ${" ".repeat(14)} ${provider.conventionEvidence}`, "");
    }
    lines.push("Pass a provider id for its models, --all for everything, --live for current prices.", "");
  } else {
    const rows = (all ? catalog.entries() : selected).map(toRow);
    const columns: Array<[string, keyof Row]> = [
      ["provider", "provider"],
      ["model", "model"],
      ["input", "input"],
      ["output", "output"],
      ["cache rd", "cachedRead"],
      ["cache wr", "cachedWrite"],
      ["thought", "thought"],
      ["extra tiers", "tiers"],
      ["data updated", "updated"],
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
