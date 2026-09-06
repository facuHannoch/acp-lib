#!/usr/bin/env bun
// The §20 real-harness investigation, as a runnable probe.
//
// The spec's metering design rests on claims about harness behaviour that ACP does not
// guarantee and the SDK contradicts itself about. This script records what each installed
// harness ACTUALLY does, so the conservative first implementation can be tightened on
// evidence rather than on hope.
//
// TWO MODES, because one of them costs money:
//
//   --connect-only (default)  initialize + session/new only. No prompt is sent, so no
//                             tokens are consumed. Answers: does the harness advertise a
//                             model? does it send a context update before any prompt?
//
//   --prompt                  Additionally sends ONE short prompt per harness and reads
//                             PromptResponse.usage. This SPENDS REAL TOKENS against
//                             whatever credentials the harness is configured with. It is
//                             the only way to answer the question that matters most —
//                             cumulative or per-turn — so it is opt-in, never default.
//
// Usage:
//   bun smoke-tests/test6-metering/harness-matrix.ts
//   bun smoke-tests/test6-metering/harness-matrix.ts --prompt
//   bun smoke-tests/test6-metering/harness-matrix.ts --prompt --only=codex,claudeCode

import { ADAPTERS, AgentSession, type AdapterPreset } from "../../src/index.ts";

const SEND_PROMPT = process.argv.includes("--prompt");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

/** Two short prompts: the second one is what reveals cumulative-vs-per-turn counters. */
const PROBE_PROMPTS = [
  "Reply with the single word: ok",
  "Reply with the single word: done",
  "Reply with the single word: bye",
];

interface Observation {
  preset: string;
  installed: boolean;
  connected: boolean;
  model: string | null;
  providerId: string | null;
  contextBeforePrompt: string;
  usagePresent: string;
  counterSemantics: string;
  categories: string;
  costReported: string;
  error?: string;
}

async function isInstalled(command: string): Promise<boolean> {
  const which = Bun.spawn(["sh", "-c", `command -v ${command}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await which.exited) === 0;
}

async function probe(preset: AdapterPreset): Promise<Observation> {
  const adapter = ADAPTERS[preset];
  const observation: Observation = {
    preset,
    installed: false,
    connected: false,
    model: null,
    providerId: null,
    contextBeforePrompt: "—",
    usagePresent: "—",
    counterSemantics: "—",
    categories: "—",
    costReported: "—",
  };

  observation.installed = await isInstalled(adapter.command[0]!);
  if (!observation.installed) return observation;

  let session: AgentSession | null = null;
  try {
    session = await AgentSession.create({
      adapter,
      adapterId: preset,
      agentSessionId: `harness-matrix-${preset}`,
      // Claude's CLI refuses to launch inside another Claude Code session, which makes
      // session/new fail with an internal error and leaves the session with no config
      // options — indistinguishable from a harness that advertises none unless cleared.
      env: { CLAUDECODE: "" },
      // No pricing: this probe records protocol facts, not costs.
      metering: { pricing: false },
    });
    // A failed session/new can still leave a constructed object, so "connected" must mean
    // a provider thread actually exists — otherwise an errored handshake reads as a
    // harness that simply advertises nothing.
    observation.connected = session.internalSessionId !== null;
    observation.providerId = session.providerId;

    // Give any post-session/new notification a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 750));
    observation.model = session.model;
    observation.contextBeforePrompt = session.contextWindow
      ? `yes (${session.contextWindow.usedTokens}/${session.contextWindow.sizeTokens})`
      : "no";

    if (!SEND_PROMPT) return observation;

    const reports: Array<Record<string, number | undefined>> = [];
    for (const text of PROBE_PROMPTS) {
      const result = await session.prompt(text);
      const record = result.metering;
      if (!record) continue;
      if (record.usage.status === "metered") {
        reports.push({ ...record.usage.reportedCumulative });
      } else if (record.usage.reportedCumulative) {
        reports.push({ ...record.usage.reportedCumulative });
      }
      observation.costReported = session.providerCost
        ? `yes (${session.providerCost.cumulative.amount} ${session.providerCost.cumulative.currency})`
        : "no";
    }

    const [first, second] = reports;
    if (!first) {
      observation.usagePresent = "no";
      observation.counterSemantics = "n/a — no usage reported";
      return observation;
    }
    observation.usagePresent = "yes";
    observation.categories = Object.keys(first).sort().join(",");

    // Growth of `totalTokens` is NOT a valid test. OpenCode reports per-turn counters
    // whose totals still rise turn over turn, because each turn re-reads the same cached
    // context — it read as "cumulative" until the components were checked.
    //
    // The decisive evidence is the component-sum identity: when totalTokens equals
    // input + output + cache for a SINGLE report, that report describes one turn.
    const componentSum = (r: Record<string, number | undefined>): number =>
      (r.inputTokens ?? 0) +
      (r.outputTokens ?? 0) +
      (r.cachedReadTokens ?? 0) +
      (r.cachedWriteTokens ?? 0) +
      (r.thoughtTokens ?? 0);

    const perTurnEvidence = reports.filter((r) => componentSum(r) === (r.totalTokens ?? -1));
    const decreasing = second
      ? (["inputTokens", "outputTokens"] as const).some(
          (key) => (second[key] ?? 0) < (first[key] ?? 0),
        )
      : false;

    if (perTurnEvidence.length === reports.length && reports.length > 1) {
      observation.counterSemantics = `PER-TURN (totals = component sum in every report)`;
    } else if (decreasing) {
      observation.counterSemantics = `PER-TURN (a component counter decreased)`;
    } else if (!second) {
      observation.counterSemantics = "indeterminate — only one report";
    } else if ((second.totalTokens ?? 0) > (first.totalTokens ?? 0)) {
      observation.counterSemantics = `cumulative (${first.totalTokens} → ${second.totalTokens})`;
    } else {
      observation.counterSemantics = `indeterminate (${first.totalTokens} → ${second.totalTokens})`;
    }
  } catch (err) {
    observation.error = String(err).slice(0, 160);
  } finally {
    await session?.stop().catch(() => {});
  }
  return observation;
}

const presets = (Object.keys(ADAPTERS) as AdapterPreset[]).filter(
  (preset) => !ONLY || ONLY.has(preset),
);

const observations: Observation[] = [];
for (const preset of presets) {
  observations.push(await probe(preset));
}

const lines: string[] = [
  "",
  `ACP metering harness matrix — ${SEND_PROMPT ? "PROMPTING (tokens spent)" : "connect-only (free)"}`,
  "",
];

const columns: Array<[string, (o: Observation) => string]> = [
  ["adapter", (o) => o.preset],
  ["installed", (o) => (o.installed ? "yes" : "no")],
  ["connected", (o) => (!o.installed ? "—" : o.connected ? "yes" : "no")],
  ["providerId", (o) => o.providerId ?? "—"],
  ["model", (o) => o.model ?? "—"],
  ["ctx pre-prompt", (o) => o.contextBeforePrompt],
  ["usage", (o) => o.usagePresent],
  ["counters", (o) => o.counterSemantics],
  ["categories", (o) => o.categories],
  ["cost", (o) => o.costReported],
];

const widths = columns.map(([header, read]) =>
  Math.max(header.length, ...observations.map((o) => read(o).length)),
);
lines.push(columns.map(([header], i) => header.padEnd(widths[i]!)).join("  "));
lines.push(widths.map((width) => "-".repeat(width)).join("  "));
for (const observation of observations) {
  lines.push(columns.map(([, read], i) => read(observation).padEnd(widths[i]!)).join("  "));
}

const errors = observations.filter((o) => o.error);
if (errors.length > 0) {
  lines.push("", "errors:");
  for (const observation of errors) lines.push(`  ${observation.preset}: ${observation.error}`);
}

if (!SEND_PROMPT) {
  lines.push(
    "",
    "usage/counters/categories need a real prompt. Re-run with --prompt to fill them in;",
    "that spends tokens against the credentials each harness is configured with.",
  );
}
lines.push("");

process.stdout.write(lines.join("\n"));
