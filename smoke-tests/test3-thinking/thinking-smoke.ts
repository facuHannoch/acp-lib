#!/usr/bin/env bun
// END-TO-END SMOKE TEST for the THINKING path, across every agent at once.
//
// test2 covers tool calls; this covers the one kind that crosses the wire incrementally,
// where a consumer can silently see nothing at all. The regression it exists for: opening a
// thinking block with a delta leaves `foldFrame` with no base to append to, so the whole
// block streams to nobody and only appears when it CLOSES. Final state looks perfect —
// which is exactly why a round-trip test misses it. Every check here therefore asserts on
// INTERMEDIATE state, not on the answer.
//
// The task is a reasoning question the agent must work out in its head, followed by one
// file read. That shape is deliberate: hard enough to make a model think, and the read is a
// single trivial tool call that proves the turn really ran without depending on the agent's
// shell skills. The correct answer is brute-forced here rather than hardcoded, so the
// ground truth cannot be wrong.
//
// Agents run in PARALLEL, one session each, in separate working directories. An agent that
// doesn't think is reported as skipped, never as passed — whether a model thinks is its
// decision (and its configuration), not a property of this library.
//
// Usage:
//   bun smoke-tests/test3-thinking/thinking-smoke.ts            # every agent on PATH
//   bun smoke-tests/test3-thinking/thinking-smoke.ts claude codex
//   bun smoke-tests/test3-thinking/thinking-smoke.ts --wire      # raw protocol per agent
//   SMOKE_TIMEOUT_MS=300000 bun smoke-tests/test3-thinking/thinking-smoke.ts
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 nothing could run.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  AgentSession,
  type AgentSessionConfig,
  createConsoleLogger,
  createWireLog,
  foldFrame,
  readActivityRecords,
  readTranscript,
  readTranscriptLines,
  wireFrames,
  type ActivityFrame,
  type AggregatedRecord,
  type WireEntry,
} from "../../src/index.ts";

type AgentId = keyof typeof ADAPTERS;

// Claude Code refuses to start inside another Claude Code session, and the reason only
// reaches stderr. Removing it here (rather than asking every caller for `env -u`) is safe:
// this is a test script, and the transport spawns agents with `{...process.env, ...env}`.
delete process.env.CLAUDECODE;

/** How hard each agent is asked to think. Tweak these and re-run to compare providers. */
const CLAUDE_THINKING_TOKENS = 8000;
const CODEX_REASONING_EFFORT = "high"; // low | medium | high
const KIMI_MODEL = null; // e.g. "kimi-k2-thinking" — null leaves the agent's own default

/**
 * Build one agent's session. Deliberately a branch per agent rather than a config table:
 * making a model think is a per-provider knob in a per-provider place, and the differences
 * are the interesting part of this test. Spelled out, they are visible and tweakable; in a
 * lookup table they turn into anonymous strings.
 *
 * Kimi     — thinks by default, nothing to set.
 * Claude   — extended thinking is OFF unless MAX_THINKING_TOKENS is in the bridge's
 *            environment; `claude-code-acp` reads it at session/new. Without it, zero
 *            thought chunks.
 * Codex    — reasoning depth is a Codex config key, not an env var: `codex-acp` forwards
 *            `-c key=value` overrides to Codex itself.
 *
 * Returns the tuning as text so the report can say what each agent actually ran with.
 */
async function createSession(
  agent: AgentId,
  common: Omit<AgentSessionConfig, "adapter" | "adapterId">,
): Promise<{ session: AgentSession; tuning: string }> {
  if (agent === "kimi") {
    const adapter = KIMI_MODEL
      ? { ...ADAPTERS.kimi, command: [...ADAPTERS.kimi.command, "--model", KIMI_MODEL] }
      : ADAPTERS.kimi;
    return {
      session: await AgentSession.create({ ...common, adapter, adapterId: "kimi" }),
      tuning: KIMI_MODEL ? `--model ${KIMI_MODEL}` : "none — thinks by default",
    };
  }

  if (agent === "claude") {
    return {
      session: await AgentSession.create({
        ...common,
        adapter: ADAPTERS.claude,
        adapterId: "claude",
        env: { MAX_THINKING_TOKENS: String(CLAUDE_THINKING_TOKENS) },
      }),
      tuning: `MAX_THINKING_TOKENS=${CLAUDE_THINKING_TOKENS} (env; without it Claude never thinks)`,
    };
  }

  if (agent === "codex") {
    // Codex's reasoning depth is neither a CLI flag nor an env var — it is one of the
    // `configOptions` the agent advertises on connect (`reasoning_effort`, low…ultra,
    // default medium), so it can only be set after the session exists. Passing
    // `-c model_reasoning_effort=…` on the command line does nothing: codex-acp embeds
    // Codex rather than shelling out to it, and silently ignores the extra argv.
    const session = await AgentSession.create({ ...common, adapter: ADAPTERS.codex, adapterId: "codex" });
    const option = session.configOptions.get("reasoning_effort");
    if (!option) return { session, tuning: "reasoning_effort not offered by this codex-acp" };
    const before = option.currentValue;
    await session.setConfig("reasoning_effort", CODEX_REASONING_EFFORT);
    // Read back: `setConfig` refreshes `configOptions` from the agent's reply, so this is
    // the agent's word for what it is running with, not ours for what we asked.
    const after = session.configOptions.get("reasoning_effort")?.currentValue;
    return {
      session,
      tuning:
        after === CODEX_REASONING_EFFORT
          ? `reasoning_effort=${after} (ACP config option, was ${before})`
          : `reasoning_effort DID NOT TAKE: asked ${CODEX_REASONING_EFFORT}, agent reports ${after}`,
    };
  }

  // gemini / copilot / opencode: no reasoning knob established here. They either think by
  // default or they don't, and the run reports SKIPPED rather than guessing at a flag.
  return {
    session: await AgentSession.create({ ...common, adapter: ADAPTERS[agent], adapterId: agent }),
    tuning: "untuned — defaults only",
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const args = process.argv.slice(2);
const wantWire = args.some((a) => a === "--wire");

const chatsDir = join(here, "chats");
await mkdir(chatsDir, { recursive: true });

// --- who runs -------------------------------------------------------------------------

const requested = args.filter((a) => !a.startsWith("-"));
for (const name of requested) {
  if (!(name in ADAPTERS)) {
    console.error(`unknown agent: ${name}`);
    console.error(`known: ${Object.keys(ADAPTERS).join(", ")}`);
    process.exit(2);
  }
}
const candidates = (requested.length > 0 ? requested : Object.keys(ADAPTERS)) as AgentId[];
const available = candidates.filter((id) => Bun.which(ADAPTERS[id].command[0]!) !== null);
const missing = candidates.filter((id) => !available.includes(id));

if (available.length === 0) {
  console.error(`none of the requested agents are on PATH: ${candidates.join(", ")}`);
  console.error(candidates.map((id) => `  ${id} -> ${ADAPTERS[id].command.join(" ")}`).join("\n"));
  process.exit(2);
}

// --- the task -------------------------------------------------------------------------

/** Brute force, so the file the agent reads is right by construction rather than by trust. */
function distinctDigitsSummingTo(target: number): number {
  let count = 0;
  for (let n = 1000; n <= 9999; n++) {
    const digits = String(n).split("").map(Number);
    if (new Set(digits).size !== 4) continue;
    if (digits.reduce((a, b) => a + b, 0) === target) count++;
  }
  return count;
}

const truth = distinctDigitsSummingTo(9);
const ANSWER_FILE = "answer.txt";

const prompt = [
  `Do this in two steps, and do NOT write or run any code, scripts, or shell commands for step 1.`,
  ``,
  `1. Work out by reasoning alone: how many four-digit numbers (1000 through 9999) have four`,
  `   DISTINCT digits that add up to exactly 9? Think it through carefully before answering.`,
  `2. Now read the file ${ANSWER_FILE} in the current directory. It holds the correct count.`,
  ``,
  `Then reply with one short paragraph stating your own count, the count from the file, and`,
  `by how much you were off.`,
].join("\n");

console.log(`agents:   ${available.join(", ")}${missing.length > 0 ? `   (not on PATH: ${missing.join(", ")})` : ""}`);
console.log(`answer:   ${truth}`);
console.log(`timeout:  ${timeoutMs}ms\n`);

// --- run ------------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Report {
  agent: AgentId;
  status: "ok" | "failed" | "no-thinking" | "error";
  checks: Check[];
  note: string;
  lines: string[];
  transcriptPath: string;
  /** For the cross-provider table. Absent when the agent never got that far. */
  stats?: { tuning: string; chunks: number; blocks: number; chars: number; tools: number };
}

const reports = await Promise.all(available.map(runAgent));

// --- report ---------------------------------------------------------------------------

let failed = 0;
for (const report of reports) {
  console.log(`\n${"=".repeat(72)}\n${report.agent}  —  ${report.transcriptPath}`);
  for (const line of report.lines) console.log(`  ${line}`);
  for (const check of report.checks) {
    if (!check.ok) failed++;
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
  }
  if (report.note) console.log(`  ${report.note}`);
}

// How the providers actually differ — the reason for running them in one go.
const withStats = reports.filter((r) => r.stats);
if (withStats.length > 0) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${"agent".padEnd(9)} ${"chunks".padStart(6)} ${"blocks".padStart(6)} ${"chars".padStart(6)} ${"tools".padStart(5)}   tuning`);
  for (const r of withStats) {
    const s = r.stats!;
    console.log(
      `${r.agent.padEnd(9)} ${String(s.chunks).padStart(6)} ${String(s.blocks).padStart(6)} ` +
        `${String(s.chars).padStart(6)} ${String(s.tools).padStart(5)}   ${s.tuning}`,
    );
  }
}

console.log(`\n${"=".repeat(72)}`);
for (const report of reports) {
  const verdict =
    report.status === "ok"
      ? `OK (${report.checks.length} checks)`
      : report.status === "no-thinking"
        ? "SKIPPED — the agent did not think"
        : report.status === "error"
          ? "ERROR"
          : `FAILED (${report.checks.filter((c) => !c.ok).length}/${report.checks.length})`;
  console.log(`${report.agent.padEnd(10)} ${verdict}`);
}

const ran = reports.filter((r) => r.status === "ok" || r.status === "failed");
if (ran.length === 0) {
  console.log(`\nSMOKE INCONCLUSIVE — no agent produced thinking to check`);
  process.exit(2);
}
console.log(failed === 0 ? `\nSMOKE OK` : `\nSMOKE FAILED (${failed} checks)`);
process.exit(failed === 0 ? 0 : 1);

// --- one agent ------------------------------------------------------------------------

async function runAgent(agent: AgentId): Promise<Report> {
  const stamp = Date.now();
  const transcriptPath = join(chatsDir, `${agent}-thinking-${stamp}.jsonl`);
  const wirePath = wantWire ? join(chatsDir, `${agent}-thinking-${stamp}.wire.jsonl`) : null;
  const lines: string[] = [];
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const workDir = await mkdtemp(join(tmpdir(), `${agent}-thinking-`));
  await writeFile(join(workDir, ANSWER_FILE), `The correct count is ${truth}.\n`, "utf8");

  // The agent's last words, kept even without --wire: a refusing agent explains itself on
  // stderr and nowhere else (claude-code-acp answers session/new with a bare "Internal
  // error"). Without this a start failure is an SDK stack trace naming nothing.
  const stderrTail: string[] = [];
  const sink = wirePath ? createWireLog({ path: wirePath }) : undefined;
  const wire = (entry: WireEntry) => {
    if (entry.dir === "err") {
      stderrTail.push(entry.line);
      if (stderrTail.length > 25) stderrTail.shift();
    }
    sink?.(entry);
  };

  const fail = (note: string): Report => ({
    agent,
    status: "error",
    checks,
    note: [note, ...stderrTail.slice(-8).map((l) => `  stderr: ${l}`)].join("\n  "),
    lines,
    transcriptPath,
  });

  console.log(`[${agent}] starting`);

  let session: AgentSession;
  let tuning: string;
  try {
    ({ session, tuning } = await createSession(agent, {
      cwd: workDir,
      transcriptPath,
      transcriptActivity: true,
      permissions: { default: "allow" },
      logger: createConsoleLogger({ minLevel: "error" }),
      wire,
    }));
  } catch (err) {
    console.log(`[${agent}] could not start`);
    return fail(`could not start a session: ${err instanceof Error ? err.message : String(err)}`);
  }
  lines.push(`tuning: ${tuning}`);

  /** Folded exactly as a browser client would, frame by frame. */
  const live = new Map<string, AggregatedRecord>();
  let chunks = 0;
  /** How many times the folded thinking text actually GREW — the anti-regression measure. */
  let steps = 0;
  let chars = 0;
  /** Bytes a streaming subscriber received for thinking, vs. the quadratic alternative. */
  let sentChars = 0;
  let quadraticChars = 0;
  /** Per-block history, to prove text only ever grew by appending. */
  const history = new Map<string, string[]>();
  let monotonic = true;

  const timer = setTimeout(() => {
    console.log(`[${agent}] timeout after ${timeoutMs}ms — interrupting`);
    session.interrupt({ clearQueue: true });
  }, timeoutMs);

  let result;
  try {
    result = await session.prompt(prompt, {
      onActivity: (event) => {
        if (event.kind === "thinking" && event.text.length > 0) {
          chunks++;
          quadraticChars += thinkingChars(live) + event.text.length; // if we resent it all
        }
      },
      onRecord: (r) => {
        for (const frame of wireFrames(r)) {
          if (isThinkingFrame(frame)) sentChars += frameChars(frame);
          foldFrame(live, frame);
        }
        for (const record of live.values()) {
          if (record.event.kind !== "thinking") continue;
          const seen = history.get(record.recordId) ?? [];
          const text = record.event.text;
          if (seen.length > 0 && seen.at(-1) !== text) {
            if (!text.startsWith(seen.at(-1)!)) monotonic = false;
            seen.push(text);
            history.set(record.recordId, seen);
          } else if (seen.length === 0) {
            history.set(record.recordId, [text]);
          }
        }
        const now = thinkingChars(live);
        if (now > chars) {
          chars = now;
          steps++;
        }
      },
      onPermissionRequest: (request) => {
        const allow =
          request.options.find((o) => o.kind === "allow_always") ??
          request.options.find((o) => o.kind === "allow_once") ??
          request.options[0];
        return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
      },
    });
  } catch (err) {
    clearTimeout(timer);
    await session.stop().catch(() => {});
    console.log(`[${agent}] threw`);
    return fail(`the turn threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  clearTimeout(timer);
  const snapshot = session.activitySnapshot();
  await session.stop().catch(() => {});
  console.log(`[${agent}] done (${chunks} thought chunks)`);

  const all = await readTranscriptLines(transcriptPath);
  const disk = await readActivityRecords(transcriptPath);
  const thinkLines = all.filter((l) => l.t === "activity" && l.kind === "thinking");
  const blocks = [...live.values()].filter((r) => r.event.kind === "thinking");
  const tools = [...live.values()].filter((r) => r.event.kind === "tool");

  lines.push(`reply: ${JSON.stringify(result.text.trim().slice(0, 120))}`);
  lines.push(
    `thinking: ${chunks} chunks -> ${blocks.length} blocks -> ${thinkLines.length} lines, ${chars} chars`,
  );
  lines.push(`tool calls: ${tools.length}   status=${result.status} stopReason=${result.stopReason}`);
  const stats = { tuning, chunks, blocks: blocks.length, chars, tools: tools.length };

  if (chunks === 0) {
    return {
      agent,
      status: "no-thinking",
      checks: [],
      note:
        `No thought chunks — the streaming checks were SKIPPED, not passed.\n  ` +
        `Whether a model thinks is its own configuration. Ran with: ${tuning}`,
      lines,
      transcriptPath,
      stats,
    };
  }

  // THE regression check. Under the old `wireFrames`, a block opened with a delta that
  // `foldFrame` dropped, so the text became visible exactly once — when the block settled.
  // That failure shows up here as steps === blocks instead of steps === chunks.
  check(
    "thinking was visible while it streamed, not only once each block closed",
    steps === chunks,
    `${steps} visible updates from ${chunks} chunks across ${blocks.length} blocks`,
  );
  check(
    "each block only ever grew, by appending",
    monotonic,
    `${[...history.values()].reduce((n, h) => n + h.length, 0)} observed states`,
  );
  // Deltas are what make thinking affordable: resending the accumulated block per chunk is
  // quadratic (~4KB of text becomes ~800KB over 400 chunks). The expected cost is exactly
  // 2× — the text crosses once as it streams, then once more as the settled record — so a
  // change that put full state on every frame fails this even on a short block.
  check(
    "the wire carried O(text), not O(text²)",
    sentChars <= chars * 2 && (chunks < 3 || sentChars < quadraticChars),
    `${sentChars} chars for ${chars} of text (${(sentChars / Math.max(chars, 1)).toFixed(1)}×); ` +
      `resending the block each chunk would be ${quadraticChars} (${(quadraticChars / Math.max(chars, 1)).toFixed(1)}×)`,
  );
  check(
    "one transcript line per block, settled",
    thinkLines.length === blocks.length && thinkLines.every((l) => l.reason === "settled"),
    `${thinkLines.length} lines / ${blocks.length} blocks`,
  );
  check(
    "the live fold and the transcript fold agree",
    blocks.every(
      (r) =>
        (disk.get(r.recordId)?.event as { text?: string } | undefined)?.text ===
        (r.event as { text: string }).text,
    ),
  );
  // Proof the turn really ran: the answer only exists in a file the agent had to read.
  check(
    `the agent read ${ANSWER_FILE}`,
    tools.length > 0 && result.text.includes(String(truth)),
    `${tools.length} tool calls, reply ${result.text.includes(String(truth)) ? "cites" : "omits"} ${truth}`,
  );
  const shape = all.filter((l) => l.t !== "meta").map((l) => (l.t === "msg" ? `msg:${l.role}` : l.t));
  check(
    "activity stayed inside the turn's msg fences",
    shape[0] === "msg:user" &&
      shape.at(-1) === "msg:assistant" &&
      shape.slice(1, -1).every((t) => t === "activity"),
  );
  check(
    "the snapshot is idle after the turn",
    snapshot.active === false && snapshot.records.length === 0,
    JSON.stringify({ active: snapshot.active, seq: snapshot.seq, records: snapshot.records.length }),
  );
  check("messages round-trip", (await readTranscript(transcriptPath)).map((m) => m.role).join(",") === "user,assistant");

  return {
    agent,
    status: checks.every((c) => c.ok) ? "ok" : "failed",
    stats,
    checks,
    note: wirePath ? `wirePath=${wirePath}` : "",
    lines,
    transcriptPath,
  };
}

// --- helpers --------------------------------------------------------------------------

function thinkingChars(records: Map<string, AggregatedRecord>): number {
  let total = 0;
  for (const record of records.values()) {
    if (record.event.kind === "thinking") total += record.event.text.length;
  }
  return total;
}

function isThinkingFrame(frame: ActivityFrame): boolean {
  return "append" in frame || (!("append" in frame) && frame.event.kind === "thinking");
}

function frameChars(frame: ActivityFrame): number {
  if ("append" in frame) return frame.append.length;
  return frame.event.kind === "thinking" ? frame.event.text.length : 0;
}
