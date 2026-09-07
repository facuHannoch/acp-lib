#!/usr/bin/env bun
// A realistic multi-turn workflow, metered end to end, then reconciled against what
// OpenCode itself recorded.
//
// SPENDS REAL TOKENS. It exists because every earlier check compared our number against
// `usage_update.cost` — which is still OpenCode telling us what it charged over the same
// channel. This runs a normal coding session (reads, writes, shell, follow-ups), then
// prints the session id so its cost can be checked against `opencode export <id>` and the
// workspace billing page, which are independent of the ACP stream.
//
// Usage:
//   bun smoke-tests/test6-metering/billing-workflow.ts [model]

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, AgentSession, createOpencodeMetering } from "../../src/index.ts";

const MODEL = process.argv[2] ?? "opencode-go/kimi-k2.6";

/** A normal coding session, not a synthetic one-liner. */
const WORKFLOW = [
  "List the files in this directory and tell me how many there are. Use your tools.",
  "Read inventory.csv and tell me the total quantity across all rows. Use your tools.",
  "Write a file called summary.txt containing that total. Use your tools.",
  "Run `wc -l inventory.csv` and tell me the output. Use your tools.",
  "What was the total quantity again?",
];

async function main() {
  const root = await mkdtemp(join(tmpdir(), "acp-billing-workflow-"));
  await writeFile(
    join(root, "inventory.csv"),
    "item,quantity\nbolts,120\nnuts,80\nwashers,45\nscrews,200\n",
    "utf8",
  );
  await writeFile(join(root, "README.md"), "# Inventory\nSmall parts.\n", "utf8");

  const metering = await createOpencodeMetering({
    onWarning: (message) => console.log(`  ! ${message}`),
  });

  const session = await AgentSession.create({
    adapter: ADAPTERS.opencode,
    adapterId: "opencode",
    agentSessionId: "billing-workflow",
    cwd: root,
    env: metering.env,
    metering: { enforcement: "billing_required", inferenceSource: metering.inferenceSource },
  });

  const ready = await metering.waitForPlugin();
  console.log(`\nplugin handshake: ${ready ? "ok" : "TIMED OUT"}`);
  if (!ready) throw new Error("metering plugin did not load");

  await session.setConfig("model", MODEL);
  console.log(`model: ${session.advertisedModel}  workspace: ${root}\n`);

  const rows: string[] = [];
  let toolCalls = 0;

  for (const [index, prompt] of WORKFLOW.entries()) {
    let turnTools = 0;
    const result = await session.prompt(prompt, {
      onActivity: (event) => {
        if (event.kind === "tool") turnTools += 1;
      },
    });
    toolCalls += turnTools;

    const record = result.metering;
    if (!record) throw new Error("expected a metering record");
    const usage = record.usage;
    const reconciliation = record.costReconciliation;

    rows.push(
      [
        String(index + 1).padStart(2),
        String(turnTools).padStart(5),
        (usage.status === "metered" ? String(usage.attributable.totalTokens) : "—").padStart(8),
        (usage.status === "metered" ? (usage.attributable.ratedTotal?.amount ?? "—") : "—").padStart(14),
        (reconciliation.status === "checked" ? reconciliation.providerDelta.amount : "—").padStart(14),
        (reconciliation.status === "checked" ? (reconciliation.ratio ?? "—") : "—").padStart(10),
        record.provenance.source,
      ].join("  "),
    );
  }

  const snapshot = session.meteringSnapshot;
  const internalSessionId = session.internalSessionId;
  // Anything the plugin saw that no operation claimed — background work, or a late
  // inference. Should be empty; if it is not, that is the number to explain.
  const unattributed = metering.drainUnattributed();

  await session.stop();
  await metering.stop();

  console.log(" # tools    tokens          rated       provider       ratio  source");
  console.log("-- -----  --------  -------------  -------------  ----------  ------");
  for (const row of rows) console.log(row);

  console.log(`\ntool calls           ${toolCalls}`);
  console.log(`operations           ${snapshot.operationCount} (metered ${snapshot.meteredOperationCount})`);
  console.log(`our session total    ${snapshot.ratedCosts[0]?.amount ?? "—"}`);
  console.log(`provider cumulative  ${session.providerCost?.cumulative.amount ?? "—"}`);
  console.log(`unattributed         ${unattributed.length} inference(s)`);
  for (const inference of unattributed) {
    console.log(`  ${inference.messageID} summary=${inference.summary} cost=${inference.cost}`);
  }
  console.log(`blocked              ${snapshot.blocked}${snapshot.blockedReason ? ` (${snapshot.blockedReason})` : ""}`);
  console.log(`\nINDEPENDENT CHECK — compare against OpenCode's own record:`);
  console.log(`  opencode export ${internalSessionId ?? "<session id unavailable>"}`);
}

await main();
