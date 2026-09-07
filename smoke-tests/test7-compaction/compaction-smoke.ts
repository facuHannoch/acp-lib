#!/usr/bin/env bun
// EXECUTABLE CONTRACT: does the certified channel see COMPACTION inferences?
//
// SPENDS REAL TOKENS. Run it yourself; it needs a paid OpenCode route.
//
// Compaction is the last known blind-spot candidate. It is a model call no user prompt
// asked for, issued by the harness when context fills. ACP never surfaces it. If the
// plugin misses it too, the integration has a smaller version of the undercount that made
// ACP unusable for billing — invisible spend that still gets charged.
//
// The test verifies itself against `opencode export`, which reads OpenCode's own database
// rather than the channel under test, so a passing result is not the library grading its
// own homework.
//
// Usage:
//   bun smoke-tests/test7-compaction/compaction-smoke.ts
//   bun smoke-tests/test7-compaction/compaction-smoke.ts --model opencode-go/hy3 --reserved 200000
//   bun smoke-tests/test7-compaction/compaction-smoke.ts --natural --turns 25
//
// Exit codes:
//   0  compaction happened and every inference was captured and reconciled
//   1  a check failed — see the report
//   2  inconclusive: the harness never compacted, or the fixture could not start
//
// Two ways to make compaction happen:
//   forced (default)  shrink the usable window with `compaction.reserved`, so it triggers
//                     within a few turns for pennies. Fast, but it changes harness config,
//                     so it is testing OpenCode under an unusual setting.
//   --natural         leave config alone and just keep talking until it fires. Slower and
//                     costs more, but it is the behaviour real consumers will hit.
//
// If the forced mode stalls, the window is too small — the harness compacts repeatedly
// without making progress. LOWER --reserved, which holds back fewer tokens and therefore
// leaves MORE usable context. Observed: 250000 against a 256k model leaves ~6k usable and
// never completes a turn.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, AgentSession, createOpencodeMetering } from "../../src/index.ts";
import { meteringPluginPath } from "../../src/metering/opencode/index.ts";
import type { ProviderInference } from "../../src/metering/opencode/index.ts";

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? "");
}
const has = (name: string) => process.argv.includes(`--${name}`);

// Guard first: every other path in this file spends money, and an unrecognised flag
// falling through to a live run is an expensive way to learn about a typo.
const KNOWN = new Set(["--model", "--reserved", "--turns", "--timeout-ms", "--natural"]);
const unknown = process.argv.slice(2).filter(
  (arg, index, all) => arg.startsWith("--") && !KNOWN.has(arg) && all[index] === arg,
);
if (has("help") || has("h") || unknown.length > 0) {
  process.stdout.write(
    (unknown.length > 0 ? `unknown flag: ${unknown.join(", ")}\n\n` : "") +
      "compaction-smoke — does the certified channel see compaction inferences?\n" +
      "SPENDS REAL TOKENS.\n\n" +
      "  --model <id>       default opencode-go/hy3\n" +
      "  --reserved <n>     tokens held back from the context limit (default 200000).\n" +
      "                     LOWER it to leave more usable window if a turn stalls.\n" +
      "  --turns <n>        default 6 forced, 25 natural\n" +
      "  --timeout-ms <n>   per-turn stall timeout (default 120000)\n" +
      "  --natural          do not touch compaction config; just keep talking\n",
  );
  process.exit(unknown.length > 0 ? 1 : 0);
}

const MODEL = flag("model") ?? "opencode-go/hy3";
const NATURAL = has("natural");
/** Tokens held back from the context limit. Higher = smaller usable window. */
const RESERVED = Number(flag("reserved") ?? 200_000);
const TURNS = Number(flag("turns") ?? (NATURAL ? 25 : 6));
/** A stalled turn is a result, not a reason to hang. */
const TURN_TIMEOUT_MS = Number(flag("timeout-ms") ?? 120_000);

interface Check {
  name: string;
  ok: boolean | null; // null = inconclusive
  detail: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean | null, detail: string): void {
  checks.push({ name, ok, detail });
}

/** Reject rather than hang: a turn that never returns is itself the finding. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms),
    ),
  ]);
}

interface ExportedAssistant {
  cost: number;
  summary: boolean;
  tokens: number;
}

/** Read OpenCode's own record of the session — the independent source. */
async function readExport(sessionId: string): Promise<ExportedAssistant[] | null> {
  try {
    const process_ = Bun.spawn(["opencode", "export", sessionId], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(process_.stdout).text();
    if ((await process_.exited) !== 0) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const raw = (parsed.messages ?? parsed.message ?? []) as unknown;
    const list = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
    const out: ExportedAssistant[] = [];
    for (const entry of list) {
      const info = ((entry as Record<string, unknown>).info ?? entry) as Record<string, any>;
      if (info?.role !== "assistant") continue;
      const tokens = info.tokens ?? {};
      out.push({
        cost: Number(info.cost ?? 0),
        summary: info.summary === true,
        tokens:
          (tokens.input ?? 0) +
          (tokens.output ?? 0) +
          (tokens.reasoning ?? 0) +
          (tokens.cache?.read ?? 0) +
          (tokens.cache?.write ?? 0),
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "acp-compaction-"));
  // Big enough to fill a shrunken window in a couple of reads; small enough to be cheap.
  const sections = Array.from(
    { length: 12 },
    (_, index) => `## Section ${index + 1}\n` + `Notes about topic ${index + 1}. `.repeat(8),
  ).join("\n\n");
  await writeFile(join(root, "notes.md"), `# Notes\n\n${sections}\n`, "utf8");

  const metering = await createOpencodeMetering({ onWarning: (m) => console.log(`  ! ${m}`) });

  const configPath = join(root, "opencode.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [meteringPluginPath()],
        // Natural mode leaves compaction settings alone, so the run exercises the harness
        // as a real consumer would meet it.
        ...(NATURAL ? {} : { compaction: { auto: true, reserved: RESERVED } }),
      },
      null,
      2,
    ),
    "utf8",
  );

  const session = await AgentSession.create({
    adapter: ADAPTERS.opencode,
    adapterId: "opencode",
    agentSessionId: "compaction-smoke",
    cwd: root,
    env: { ...metering.env, OPENCODE_CONFIG: configPath },
    metering: { enforcement: "billing_required", inferenceSource: metering.inferenceSource },
  });

  const ready = await metering.waitForPlugin();
  check("metering plugin loaded", ready, ready ? "handshake received" : "no handshake");
  if (!ready) return 2;

  await session.setConfig("model", MODEL);
  console.log(
    `mode ${NATURAL ? "natural" : `forced (reserved ${RESERVED.toLocaleString()})`}  ` +
      `model ${session.advertisedModel}  turns ${TURNS}\n`,
  );

  const observed: ProviderInference[] = [];
  let stalled: string | null = null;
  let ratioFailures = 0;
  let unavailable = 0;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    // Alternating reads keep adding context until the window overflows.
    const prompt =
      turn % 3 === 0
        ? "How many sections have you seen so far? Answer from memory, no tools."
        : `Read notes.md and reply with the heading of section ${turn}. Use your tools.`;

    let record: Awaited<ReturnType<typeof session.prompt>>["metering"] = null;
    try {
      record = (await withTimeout(session.prompt(prompt), TURN_TIMEOUT_MS, `turn ${turn}`))
        .metering;
    } catch (error) {
      stalled = String(error).slice(0, 120);
      console.log(`  turn ${turn}: ${stalled}`);
      break;
    }
    if (!record) continue;

    const usage = record.usage;
    const reconciliation = record.costReconciliation;
    if (usage.status !== "metered") unavailable += 1;
    if (reconciliation.status === "checked" && !reconciliation.matches) ratioFailures += 1;

    console.log(
      `  turn ${String(turn).padStart(2)}  ` +
        `tokens ${(usage.status === "metered" ? usage.attributable.totalTokens : 0).toString().padStart(7)}  ` +
        `ratio ${(reconciliation.status === "checked" ? (reconciliation.ratio ?? "?") : "—").padStart(9)}  ` +
        `ctx ${record.contextAfter?.usedTokens ?? "?"}/${record.contextAfter?.sizeTokens ?? "?"}`,
    );
  }

  const snapshot = session.meteringSnapshot;
  const internalSessionId = session.internalSessionId;
  observed.push(...metering.drainUnattributed());
  await session.stop();
  await metering.stop();

  if (stalled) {
    check(
      "turns completed",
      false,
      `stalled: ${stalled}. In forced mode this usually means the window is too small — ` +
        `RAISE --reserved is wrong, LOWER it to leave more usable context.`,
    );
  }

  // --- the independent check --------------------------------------------------------
  const exported = internalSessionId ? await readExport(internalSessionId) : null;
  if (!exported) {
    check("opencode export readable", null, "could not read OpenCode's own session record");
    return report(2);
  }

  const compactions = exported.filter((message) => message.summary).length;
  if (compactions === 0) {
    check(
      "compaction occurred",
      null,
      NATURAL
        ? `no compaction in ${TURNS} turns — run with more --turns, or use forced mode`
        : `no compaction at reserved=${RESERVED} — lower it to shrink the window further`,
    );
    return report(2);
  }
  check("compaction occurred", true, `${compactions} compaction inference(s) in the session`);

  const exportedCost = exported.reduce((total, message) => total + message.cost, 0);
  const exportedTokens = exported.reduce((total, message) => total + message.tokens, 0);
  const ourCost = Number(snapshot.ratedCosts[0]?.amount ?? 0);
  const ourTokens = snapshot.totals.total.knownTokens;

  // Costs are floats on OpenCode's side; compare at the precision the API reports.
  const costMatches = Math.abs(exportedCost - ourCost) < 1e-9;
  check(
    "cost matches OpenCode's own record",
    costMatches,
    `ours ${ourCost} vs export ${exportedCost}`,
  );
  check(
    "tokens match OpenCode's own record",
    ourTokens === exportedTokens,
    `ours ${ourTokens} vs export ${exportedTokens}`,
  );
  check(
    "compaction inferences were captured",
    costMatches,
    costMatches
      ? `totals agree with ${compactions} compaction inference(s) included`
      : `totals differ — the gap is what the channel missed`,
  );
  check(
    "every operation reconciled",
    ratioFailures === 0,
    ratioFailures === 0 ? "all ratios 1" : `${ratioFailures} operation(s) diverged`,
  );
  check(
    "no operation was unmeasured",
    unavailable === 0,
    unavailable === 0 ? "all operations metered" : `${unavailable} unavailable`,
  );
  check(
    "nothing left unattributed",
    observed.length === 0,
    observed.length === 0
      ? "every observed inference belonged to an operation"
      : `${observed.length} inference(s) observed outside any operation ` +
        `(${observed.filter((i) => i.summary).length} compaction) — these belong in ` +
        `unallocatedUsage, not silently dropped`,
  );
  check(
    "session never blocked",
    !snapshot.blocked,
    snapshot.blockedReason ?? "not blocked",
  );

  return report(checks.some((entry) => entry.ok === false) ? 1 : 0);
}

function report(code: number): number {
  const lines = ["", "COMPACTION VISIBILITY", ""];
  for (const entry of checks) {
    const status = entry.ok === null ? "SKIP" : entry.ok ? "PASS" : "FAIL";
    lines.push(`${status}  ${entry.name} — ${entry.detail}`);
  }
  const failures = checks.filter((entry) => entry.ok === false).length;
  lines.push(
    "",
    code === 2
      ? "result: INCONCLUSIVE — compaction did not happen, so nothing was proven"
      : `result: ${checks.length - failures}/${checks.length} checks passed`,
    "",
  );
  process.stdout.write(lines.join("\n"));
  return code;
}

process.exit(await main());
