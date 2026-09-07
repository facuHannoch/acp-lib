#!/usr/bin/env bun
// Generates the pinned models.dev pricing catalog shipped as the library's default
// pricing source. See 9-6-SPEC-metering.md §7.
//
// Run at release time:  bun run generate:pricing
//
// The transform lives in src/metering/catalog/build.ts, shared with the optional live
// resolver so both produce identical policies from one set of rules. This script only
// does the parts that belong to a build: fetch, pin, digest, write.
//
// Two properties it exists to guarantee:
//
//   1. Float never reaches a rated cost. models.dev delivers prices as JSON numbers; they
//      become canonical decimal strings HERE, at build time, so runtime pricing only ever
//      multiplies BigInt-backed decimals.
//
//   2. A record stays reproducible. The artifact is pinned to an immutable upstream commit
//      and identified by its own SHA-256, so "what did this cost" is answerable years
//      later without consulting a mutable catalog. models.dev publishes no versioning
//      scheme and no update-frequency guarantee, which is exactly why this matters.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCatalog,
  serializeCatalog,
  type RawProvider,
} from "../src/metering/catalog/build.ts";

const CATALOG_URL = "https://models.dev/api.json";
const REPO = "anomalyco/models.dev";
const REPO_REF = "dev";

const OUT_DIR = join(import.meta.dir, "..", "src", "metering", "catalog");

async function main() {
  console.log(`fetching ${CATALOG_URL}`);
  const response = await fetch(CATALOG_URL);
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
  const raw = (await response.json()) as Record<string, RawProvider>;

  // Resolve the mutable ref to an immutable commit. "Latest" is the input; a fixed SHA is
  // what gets engraved, because that is what makes an old record reproducible.
  const commitResponse = await fetch(`https://api.github.com/repos/${REPO}/commits/${REPO_REF}`, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (!commitResponse.ok) {
    throw new Error(`GitHub returned ${commitResponse.status} resolving ${REPO}@${REPO_REF}`);
  }
  const commit = ((await commitResponse.json()) as { sha?: string }).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`could not resolve an upstream commit for ${REPO}@${REPO_REF}`);
  }
  console.log(`pinned ${REPO}@${commit}`);

  const { catalog, modelCount, skippedCount } = buildCatalog(raw);
  const catalogJson = serializeCatalog(catalog);
  const artifactSha256 = createHash("sha256").update(catalogJson, "utf8").digest("hex");

  const meta = { kind: "models.dev" as const, commit, artifactSha256, generatedAt: Date.now() };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "models-dev.catalog.json"), catalogJson, "utf8");
  await writeFile(join(OUT_DIR, "models-dev.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  console.log(
    `wrote ${Object.keys(catalog.providers).length} providers, ${modelCount} models ` +
      `(${skippedCount} skipped for missing prices)`,
  );
  console.log(`artifact sha256 ${artifactSha256}`);
  console.log(`catalog ${(catalogJson.length / 1024).toFixed(1)} KiB`);
}

await main();
