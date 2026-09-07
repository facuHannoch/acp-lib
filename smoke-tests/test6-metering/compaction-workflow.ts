#!/usr/bin/env bun
// Does the certified channel capture COMPACTION inferences?
//
// SPENDS REAL TOKENS (a few cents).
//
// Compaction is the remaining blind-spot candidate: a model call no user prompt asked for,
// issued by the harness when context fills. If the plugin misses it, the integration has a
// smaller version of the ACP undercount — invisible spend that still gets billed.
//
// Rather than filling a 256k window, this shrinks the usable one. OpenCode's
// `compaction.reserved` is a token buffer held back from the context limit, so setting it
// near the limit leaves a few thousand usable tokens and forces compaction within a couple
// of turns, for pennies.
//
// Usage:
//   bun smoke-tests/test6-metering/compaction-workflow.ts [model] [reservedTokens]

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, AgentSession, createOpencodeMetering } from "../../src/index.ts";
import { meteringPluginPath } from "../../src/metering/opencode/index.ts";

const MODEL = process.argv[2] ?? "opencode-go/hy3";
const RESERVED = Number(process.argv[3] ?? 250_000);

const TURNS = [
  "Read notes.md and summarise it in one sentence. Use your tools.",
  "Read notes.md again and list the section headings. Use your tools.",
  "How many sections were there? Answer from memory.",
  "Read notes.md once more and quote its first line. Use your tools.",
  "Summarise everything we have discussed so far in one sentence.",
];

async function main() {
  const root = await mkdtemp(join(tmpdir(), "acp-compaction-"));
  // Big enough that a couple of reads exhaust a deliberately tiny window.
  const sections = Array.from(
    { length: 40 },
    (_, index) =>
      `## Section ${index + 1}\n` +
      `Notes about topic ${index + 1}. `.repeat(20),
  ).join("\n\n");
  await writeFile(join(root, "notes.md"), `# Notes\n\n${sections}\n`, "utf8");

  const metering = await createOpencodeMetering({
    onWarning: (message) => console.log(`  ! ${message}`),
  });

  // A managed config of our own: the shipped one merges the user's settings, and this test
  // additionally needs a shrunken context window.
  const configPath = join(root, "opencode.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [meteringPluginPath()],
        compaction: { auto: true, reserved: RESERVED },
      },
      null,
      2,
    ),
    "utf8",
  );

  const session = await AgentSession.create({
    adapter: ADAPTERS.opencode,
    adapterId: "opencode",
    agentSessionId: "compaction-workflow",
    cwd: root,
    env: { ...metering.env, OPENCODE_CONFIG: configPath },
    metering: { enforcement: "billing_required", inferenceSource: metering.inferenceSource },
  });

  if (!(await metering.waitForPlugin())) throw new Error("metering plugin did not load");
  await session.setConfig("model", MODEL);
  console.log(`model ${session.advertisedModel}  reserved ${RESERVED.toLocaleString()} tokens\n`);

  const rows: string[] = [];
  for (const [index, prompt] of TURNS.entries()) {
    let failure: string | null = null;
    let record: Awaited<ReturnType<typeof session.prompt>>["metering"] = null;
    try {
      record = (await session.prompt(prompt)).metering;
    } catch (error) {
      failure = String(error).slice(0, 60);
    }
    if (!record) {
      rows.push(`${String(index + 1).padStart(2)}  ${failure ?? "no record"}`);
      continue;
    }
    const usage = record.usage;
    const reconciliation = record.costReconciliation;
    rows.push(
      [
        String(index + 1).padStart(2),
        (usage.status === "metered" ? String(usage.attributable.totalTokens) : "—").padStart(9),
        (usage.status === "metered" ? (usage.attributable.ratedTotal?.amount ?? "—") : "—").padStart(14),
        (reconciliation.status === "checked" ? (reconciliation.ratio ?? "—") : "—").padStart(10),
        (reconciliation.status === "checked" ? String(reconciliation.matches) : "—").padStart(7),
        `ctx ${record.contextAfter?.usedTokens ?? "?"}/${record.contextAfter?.sizeTokens ?? "?"}`,
      ].join("  "),
    );
  }

  const snapshot = session.meteringSnapshot;
  const internalSessionId = session.internalSessionId;
  const unattributed = metering.drainUnattributed();
  await session.stop();
  await metering.stop();

  console.log(" #     tokens          rated       ratio  matches  context");
  console.log("--  ---------  -------------  ----------  -------  -------");
  for (const row of rows) console.log(row);

  console.log(`\noperations           ${snapshot.operationCount} (metered ${snapshot.meteredOperationCount})`);
  console.log(`our session total    ${snapshot.ratedCosts[0]?.amount ?? "—"}`);
  console.log(`provider cumulative  ${session.providerCost?.cumulative.amount ?? "—"}`);
  console.log(`unattributed         ${unattributed.length}`);
  for (const inference of unattributed) {
    console.log(`  summary=${inference.summary} cost=${inference.cost} tokens=${inference.tokens.totalTokens}`);
  }
  console.log(`blocked              ${snapshot.blocked}${snapshot.blockedReason ? ` (${snapshot.blockedReason})` : ""}`);
  console.log(`\nCheck compaction actually happened, and that we saw it:`);
  console.log(`  opencode export ${internalSessionId ?? "<unavailable>"} | grep -c '"summary": *true'`);
}

await main();
