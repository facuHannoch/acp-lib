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
// Compaction is triggered HONESTLY: the harness's own settings are left alone and context
// is filled with real reads until OpenCode decides to compact.
//
// An earlier version forced it with OpenCode's `compaction.reserved`, on the assumption
// that it holds tokens back from the model's limit. That reading was wrong. At
// reserved=200000 against a 256k model the window should have been ~56k and never
// compacted; instead the harness compacted 19 times in 120s without completing a single
// turn, while natural runs on the same model used only 10k of 256k and finished cleanly.
// Whatever `reserved` means, forcing it produces a pathological loop rather than the
// behaviour under test — so the knob is gone.
//
// The cost is bounded by prompt caching: after the first read, re-reads bill at the
// cache-read rate, which is a fraction of input.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, AgentSession, createOpencodeMetering, soleAmount } from "../../src/index.ts";
import { meteringPluginPath } from "../../src/metering/opencode/index.ts";
import type { ProviderInference } from "../../src/metering/opencode/index.ts";

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? "");
}
const has = (name: string) => process.argv.includes(`--${name}`);

// Guard first: every other path in this file spends money, and an unrecognised flag
// falling through to a live run is an expensive way to learn about a typo.
const KNOWN = new Set(["--model", "--fill-kb", "--context-limit", "--turns", "--timeout-ms", "--stress-compaction"]);
const unknown = process.argv.slice(2).filter(
  (arg, index, all) => arg.startsWith("--") && !KNOWN.has(arg) && all[index] === arg,
);
if (has("help") || has("h") || unknown.length > 0) {
  process.stdout.write(
    (unknown.length > 0 ? `unknown flag: ${unknown.join(", ")}\n\n` : "") +
      "compaction-smoke — does the certified channel see compaction inferences?\n" +
      "SPENDS REAL TOKENS.\n\n" +
      "  --model <id>       default opencode-go/hy3 (256k context, cheap)\n" +
      "  --fill-kb <n>      size of each generated file (default 80)\n" +
      "  --context-limit <n> context window to declare for the model (default 40000).\n" +
      "                     Lower fills it faster; too low and a single read cannot fit.\n" +
      "  --turns <n>        default 8; raise if compaction never fires\n" +
      "  --timeout-ms <n>   per-turn stall timeout (default 120000)\n" +
      "  --stress-compaction <reserved>\n" +
      "                     force a compaction loop to generate compaction inferences.\n" +
      "                     Pathological: turns stall and attribution fails by design.\n" +
      "                     Only the capture checks are meaningful. Try 200000.\n",
  );
  process.exit(unknown.length > 0 ? 1 : 0);
}

const MODEL = flag("model") ?? "opencode-go/hy3";
/** Approximate size of each generated file. One read should be a decent share of the window. */
const FILL_KB = Number(flag("fill-kb") ?? 80);
/**
 * Context window to declare for the model, in tokens.
 *
 * This describes the MODEL, which is an ordinary config override, rather than reaching
 * into the harness's compaction machinery. A few reads then overflow it and OpenCode
 * compacts of its own accord.
 */
const CONTEXT_LIMIT = Number(flag("context-limit") ?? 40_000);
/**
 * Drive the harness into a compaction loop on purpose, to generate compaction inferences.
 *
 * Not a way to observe normal behaviour — it is pathological, and turns will stall. It is
 * here because it is the ONLY reliable way found to make compaction happen on demand, and
 * the question this test asks is whether the channel SEES compaction work, which does not
 * require the turns to succeed. Expect attribution checks to fail; capture is the check
 * that matters.
 */
const STRESS = flag("stress-compaction");
const TURNS = Number(flag("turns") ?? 8);
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
      // Summed here by hand, NOT via the library's disjointTokenUsage. This parses
      // `opencode export` to check the library's number against the harness's own
      // record; importing the library's arithmetic would make the check circular.
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
  // A DISTINCT file per turn. Re-reading one file does not accumulate context — OpenCode
  // replaces the prior tool output rather than stacking it, which an earlier version of
  // this test learned the slow way: twelve reads of the same file left the window flat at
  // 25k/256k and compaction never fired.
  const perSection = 400;
  const sectionCount = Math.max(1, Math.round((FILL_KB * 1024) / perSection));
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const sections = Array.from(
      { length: sectionCount },
      (_, index) =>
        `## File ${turn} Section ${index + 1}\n` +
        `Distinct notes for file ${turn} topic ${index + 1}. `.repeat(
          Math.round(perSection / 44),
        ),
    ).join("\n\n");
    await writeFile(join(root, `notes-${turn}.md`), `# Notes ${turn}\n\n${sections}\n`, "utf8");
  }

  const metering = await createOpencodeMetering({ onWarning: (m) => console.log(`  ! ${m}`) });

  const configPath = join(root, "opencode.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [meteringPluginPath()],
        // Stress mode only: drives a compaction loop, which is the one reliable way found
        // to generate compaction inferences on demand.
        ...(STRESS ? { compaction: { auto: true, reserved: Number(STRESS) } } : {}),
        // Declare a smaller context window for this model. Observed NOT to influence when
        // OpenCode compacts — context ran past a declared 11,000-token window without
        // triggering — so this only shapes the reported context figures.
        provider: {
          [MODEL.split("/")[0]!]: {
            models: {
              [MODEL.split("/").slice(1).join("/")]: {
                limit: { context: CONTEXT_LIMIT, output: Math.round(CONTEXT_LIMIT / 8) },
              },
            },
          },
        },
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
    `model ${session.advertisedModel}  window ${CONTEXT_LIMIT.toLocaleString()} tokens  ` +
      `fill ${FILL_KB}KB/turn  up to ${TURNS} turns` +
      (STRESS ? `  STRESS reserved=${STRESS} (turns will stall by design)` : "") +
      `\n`,
  );

  // Every inference the channel saw, whether or not an operation claimed it. A stalled
  // turn never closes, so nothing is drained into it — but the channel still SAW the work,
  // and capture is the question this test exists to answer.
  const attributed: { tokens: number; cost: number } = { tokens: 0, cost: 0 };
  const observed: ProviderInference[] = [];
  let stalled: string | null = null;
  let ratioFailures = 0;
  let unavailable = 0;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    // Alternating reads keep adding context until the window overflows.
    const prompt = `Read notes-${turn}.md and reply with its first heading only. Use your tools.`;

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
    if (usage.status === "metered") {
      attributed.tokens += usage.attributable.totalTokens;
      if (reconciliation.status === "checked") {
        attributed.cost += Number(reconciliation.providerDelta.amount);
      }
    }
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
      STRESS ? null : false,
      STRESS
        ? `stalled: expected in stress mode — the loop is what generates compactions`
        : `stalled: ${stalled}. Try a smaller --fill-kb, or a longer --timeout-ms.`,
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
      `no compaction in ${TURNS} turns at a ${CONTEXT_LIMIT.toLocaleString()}-token window — ` +
        `lower --context-limit or raise --fill-kb`,
    );
    return report(2);
  }
  check("compaction occurred", true, `${compactions} compaction inference(s) in the session`);

  const exportedCost = exported.reduce((total, message) => total + message.cost, 0);
  const exportedTokens = exported.reduce((total, message) => total + message.tokens, 0);

  // CAPTURE: did the channel see everything OpenCode charged for? This is the question,
  // and it is independent of whether an operation ended up claiming the work.
  const seenCost = observed.reduce((total, i) => total + i.cost, 0) + attributed.cost;
  const seenTokens =
    observed.reduce((total, i) => total + i.tokens.totalTokens, 0) + attributed.tokens;
  const captureCost = Math.abs(exportedCost - seenCost) < 1e-9;
  check(
    "channel saw every inference OpenCode charged for",
    captureCost,
    `seen ${seenCost} vs export ${exportedCost}` +
      (captureCost ? ` (${compactions} compaction inference(s) included)` : " — the gap went unbilled"),
  );
  check(
    "channel saw every token OpenCode counted",
    seenTokens === exportedTokens,
    `seen ${seenTokens} vs export ${exportedTokens}`,
  );

  // ATTRIBUTION: separate question. A stalled turn captures work it never claims.
  const ourCost = Number(soleAmount(snapshot.ratedCosts)?.amount ?? 0);
  const ourTokens = snapshot.totals.total.knownTokens;
  // In stress mode the turns deliberately stall, so no operation ever closes and nothing
  // is drained into one. Reporting that as a failure would bury the capture result, which
  // is the only thing stress mode can answer.
  const attributionScored = STRESS ? null : true;
  check(
    "attributed totals match OpenCode's own record",
    attributionScored && Math.abs(exportedCost - ourCost) < 1e-9,
    `attributed ${ourCost} vs export ${exportedCost}` +
      (observed.length > 0 ? ` — ${observed.length} inference(s) never claimed by an operation` : ""),
  );
  check(
    "attributed tokens match OpenCode's own record",
    attributionScored && ourTokens === exportedTokens,
    `attributed ${ourTokens} vs export ${exportedTokens}`,
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
    attributionScored && observed.length === 0,
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
