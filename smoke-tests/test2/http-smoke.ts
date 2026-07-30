#!/usr/bin/env bun
// END-TO-END SMOKE TEST against a real agent: make it stand up a Python HTTP server, curl
// it, and report the status code. Small task, but it needs everything the library promises
// for a working tool call — write a file, run commands, read their output back — so the
// failure modes it catches are the ones that matter:
//
//   - tool output never reaching the caller (the `{}` tool block bug)
//   - a settled transcript that disagrees with what was streamed live (fold drift)
//   - activity lines multiplying per notification instead of per lifecycle step
//   - msg/activity ordering breaking the turn fences a reader groups by
//   - a thinking block that only materializes when it closes (nothing streams)
//
// It checks the library, not the model: the pass condition is that OUR stream carried the
// evidence, not that the agent phrased its answer nicely. That is also why it runs against
// ANY adapter — one agent going quiet or losing its auth says nothing about the library,
// and the quickest way to tell the two apart is to point it at a different agent.
//
// Usage:
//   bun smoke-tests/test2/http-smoke.ts                 # default: kimi
//   bun smoke-tests/test2/http-smoke.ts claude
//   bun smoke-tests/test2/http-smoke.ts codex --wire    # raw protocol to a file
//   bun smoke-tests/test2/http-smoke.ts kimi --wire=stderr
//   SMOKE_TIMEOUT_MS=300000 bun smoke-tests/test2/http-smoke.ts claude
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 could not run (unknown agent,
// binary missing, or the agent produced nothing at all — see "inconclusive" below).
//
// Requires the chosen agent's CLI on PATH and authenticated, plus python3 and curl.

import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  AgentSession,
  createConsoleLogger,
  createWireLog,
  foldFrame,
  readActivityRecords,
  readTranscript,
  readTranscriptLines,
  wireFrames,
  type AggregatedRecord,
  type PromptResult,
  type ToolActivity,
  type WireEntry,
} from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// KIMI_SMOKE_TIMEOUT_MS still works — it was the documented name while this was kimi-only.
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? process.env.KIMI_SMOKE_TIMEOUT_MS ?? 240_000);

// --- which agent ----------------------------------------------------------------------
// Any preset works; nothing below is agent-specific. `kimi` is only the default because it
// is what the checks were first measured against.
const args = process.argv.slice(2);
const requested =
  args.find((a) => a.startsWith("--agent="))?.slice("--agent=".length) ??
  args.find((a) => !a.startsWith("-")) ??
  process.env.SMOKE_AGENT ??
  "kimi";

if (!(requested in ADAPTERS)) {
  console.error(`unknown agent: ${requested}`);
  console.error(`known: ${Object.keys(ADAPTERS).join(", ")}`);
  process.exit(2);
}
const agentId = requested as keyof typeof ADAPTERS;
const adapter = ADAPTERS[agentId];

// Fail before spawning: a missing binary otherwise surfaces as a connect timeout, which
// reads like a library problem.
const binary = adapter.command[0]!;
if (!Bun.which(binary)) {
  console.error(`${agentId}: \`${binary}\` is not on PATH (adapter command: ${adapter.command.join(" ")})`);
  console.error(`install it, or pick another: ${Object.keys(ADAPTERS).join(", ")}`);
  process.exit(2);
}

const port = await freePort();

const chatsDir = join(here, "chats");
await mkdir(chatsDir, { recursive: true });
const stamp = Date.now();
const transcriptPath = join(chatsDir, `${agentId}-http-${stamp}.jsonl`);

// --wire dumps every raw protocol line. The file form is the useful one here: to stderr it
// interleaves with the streamed reply.
const wireArg = args.find((a) => a === "--wire" || a.startsWith("--wire="));
const wirePath = wireArg === "--wire" ? join(chatsDir, `${agentId}-http-${stamp}.wire.jsonl`) : null;
const sink = !wireArg
  ? undefined
  : wireArg === "--wire"
    ? createWireLog({ path: wirePath! })
    : createWireLog({ console: "stderr" });

// Keep the agent's last stderr lines even without --wire. When a start fails, that is where
// the reason is: claude-code-acp answers `session/new` with a bare "Internal error" and
// explains itself only on stderr ("cannot be launched inside another Claude Code session").
// Without this the script dies on an SDK stack trace that names nothing useful.
const stderrTail: string[] = [];
const wire = (entry: WireEntry) => {
  if (entry.dir === "err") {
    stderrTail.push(entry.line);
    if (stderrTail.length > 25) stderrTail.shift();
  }
  sink?.(entry);
};

/** Report an agent that never got as far as talking to us, and say what it said. */
function bail(what: string, err: unknown): never {
  console.error(`\n${agentId}: ${what}`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  if (stderrTail.length > 0) {
    console.error(`\nwhat \`${adapter.command.join(" ")}\` wrote to stderr:`);
    for (const line of stderrTail) console.error(`  ${line}`);
  }
  if (wirePath) console.error(`\nwirePath=${wirePath}`);
  console.error(`\nSMOKE INCONCLUSIVE`);
  process.exit(2);
}

// The agent works in a throwaway directory, never the repo.
const workDir = await mkdtemp(join(tmpdir(), `${agentId}-http-smoke-`));

const prompt = [
  `Work in the current directory using shell commands.`,
  `1. Write a file server.py: a Python 3 standard-library HTTP server bound to 127.0.0.1:${port} that answers any GET with status 200 and the body "smoke ok".`,
  `2. Start it in the background and wait until it accepts connections.`,
  `3. Run exactly this and note what it prints:`,
  `   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/`,
  `4. Stop the server.`,
  // Ask for a sentence, not a bare number: a one-token reply makes "the agent answered"
  // indistinguishable from "the agent said nothing", and barely exercises onChunk.
  `Then reply with one short sentence stating the HTTP status code curl printed and whether the server worked.`,
].join("\n");

console.log(`agent=${adapter.displayName ?? agentId} (${adapter.command.join(" ")})`);
console.log(`workDir=${workDir}`);
console.log(`port=${port}`);
console.log(`transcriptPath=${transcriptPath}\n`);

const session = await AgentSession.create({
  adapter,
  adapterId: agentId,
  cwd: workDir,
  transcriptPath,
  transcriptActivity: true,
  defaultPermission: "approve",
  logger: createConsoleLogger({ minLevel: "warn" }),
  wire,
}).catch((err) => bail("could not start a session", err));

/** Everything the LIVE stream said, folded exactly the way a browser client would. */
const live = new Map<string, AggregatedRecord>();
let rawEvents = 0;
let permissions = 0;
let terminalBacked = false;
// Thinking is the one kind that crosses the wire incrementally, so it is the one kind a
// subscriber can silently see NOTHING of while the model works. Count the chunks that went
// in against the times the folded text actually grew.
let thinkingChunks = 0;
let thinkingSteps = 0;
let thinkingChars = 0;

const timer = setTimeout(() => {
  console.error(`\n[timeout] no result after ${timeoutMs}ms — interrupting`);
  session.interrupt({ clearQueue: true });
}, timeoutMs);

let result: PromptResult | undefined;
let failure: unknown;
try {
  result = await session.prompt(prompt, {
    onChunk: (text) => process.stdout.write(text),
    onActivity: (event) => {
      rawEvents++;
      if (event.kind === "thinking" && event.text.length > 0) thinkingChunks++;
      if (event.kind === "tool" || event.kind === "tool_update") {
        for (const entry of event.content ?? []) {
          if (entry.type === "terminal") terminalBacked = true;
        }
      }
    },
    onRecord: (r) => {
      for (const frame of wireFrames(r)) foldFrame(live, frame);
      // Exactly what a browser would have on screen at this instant.
      const chars = thinkingTextOf(live).length;
      if (chars > thinkingChars) {
        thinkingChars = chars;
        thinkingSteps++;
      }
    },
    onPermissionRequest: (request) => {
      permissions++;
      // Prefer an explicit allow; fall back to the first option the agent offered.
      const allow =
        request.options.find((o) => o.kind === "allow_always") ??
        request.options.find((o) => o.kind === "allow_once") ??
        request.options[0];
      if (!allow) return { outcome: "cancelled" };
      return { outcome: "selected", optionId: allow.optionId };
    },
  });
} catch (err) {
  failure = err;
} finally {
  // Stop first either way: it is what flushes the transcript we are about to read.
  clearTimeout(timer);
  await session.stop().catch(() => {});
}

if (!result) {
  await killPort(port);
  bail("the turn threw", failure);
}

if (!result.text.endsWith("\n")) process.stdout.write("\n");

// An agent that says NOTHING — no activity, no text — fails every check below for one
// reason that is not ours. Seen for real: Kimi accepted a prompt, sent its command list,
// went silent for 243s, then answered our cancel in 11ms. The protocol layer was healthy
// the whole time; the model never started. Report that as inconclusive, not as 12 failures.
if (rawEvents === 0 && result.text.trim() === "") {
  console.log(`\nThe agent produced nothing at all: 0 activity events, 0 text.`);
  console.log(`stopReason=${result.stopReason} status=${result.status}`);
  console.log(`The protocol layer is not implicated — it connected, prompted, and shut down.`);
  console.log(`Check the agent: run \`${adapter.ptyCommand?.[0] ?? binary}\` interactively (quota, auth, backend),`);
  console.log(`or point this at another one: ${Object.keys(ADAPTERS).filter((a) => a !== agentId).join(", ")}`);
  if (wirePath) console.log(`wirePath=${wirePath}`);
  await killPort(port);
  console.log(`\nSMOKE INCONCLUSIVE`);
  process.exit(2);
}

// --- what we can check without the model's cooperation ---------------------------------

const disk = await readActivityRecords(transcriptPath);
const lines = await readTranscriptLines(transcriptPath);
const activityLines = lines.filter((l) => l.t === "activity");
const liveTools = toolsOf(live);
const diskTools = toolsOf(disk);
const commandOutput = liveTools.flatMap(collectText).join("\n");
const files = await readdir(workDir);

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push([name, ok, detail]);

check("prompt completed", result.status === "completed", `status=${result.status} stopReason=${result.stopReason}`);
check("the agent ran at least one tool", liveTools.length > 0, `${liveTools.length} tool calls`);
check(
  "every tool call reached a terminal status",
  liveTools.length > 0 && liveTools.every((t) => t.status === "completed" || t.status === "failed"),
  liveTools.map((t) => `${t.title ?? t.toolKind}=${t.status}`).join(", "),
);

// THE point of the exercise: the command's output came back to us through the activity
// stream. `200` in the agent's prose proves nothing — it can say that without running it.
check("a tool call carried the 200 status in its output", /\b200\b/.test(commandOutput));
check("the agent also reported 200", /\b200\b/.test(result.text), JSON.stringify(result.text.slice(0, 160)));
// A reply that streamed as text, not just a settled number — this is the onChunk path.
check("the reply is a real sentence", result.text.trim().split(/\s+/).length >= 4, `${result.text.trim().split(/\s+/).length} words`);
check(
  "the transcript kept the assistant reply",
  (await readTranscript(transcriptPath)).at(-1)?.text === result.text,
);
check("server.py was written to our cwd", files.includes("server.py"), `files=${files.join(", ")}`);

// The fold is the same on both sides, which is the whole anti-drift argument: one
// aggregator, one set of semantics, so a reload cannot show something else.
const drift = liveTools
  .filter((t) => !sameCall(t, diskTools.find((d) => d.toolCallId === t.toolCallId)))
  .map((t) => t.toolCallId);
check("the live fold and the transcript fold agree", drift.length === 0, drift.join(", "));

// Volume: a settled transcript writes per lifecycle step, not per notification.
const toolLines = activityLines.filter((l) => l.kind === "tool").length;
check(
  "the transcript folded the delta stream down",
  activityLines.length < rawEvents,
  `${rawEvents} raw events -> ${activityLines.length} lines (${toolLines} tool, ${liveTools.length} calls)`,
);
check(
  "each tool call cost at most 3 lines",
  liveTools.length === 0 || toolLines <= liveTools.length * 3,
  `${toolLines} lines / ${liveTools.length} calls`,
);
check(
  "every activity line is foldable",
  activityLines.length > 0 && activityLines.every((l) => typeof l.recordId === "string" && typeof l.reason === "string"),
);

// Thinking: only checkable when the model actually thought, which is its call, not ours.
const thinkLines = activityLines.filter((l) => l.kind === "thinking");
const thinkBlocks = [...live.values()].filter((r) => r.event.kind === "thinking");
if (thinkingChunks > 0) {
  // The regression that prompted these: opening a block with a delta leaves the consumer
  // with no base to append to, so the whole block appears at once when it CLOSES. Final
  // state looks perfect; nothing streams. That failure shows up here as steps == blocks.
  check(
    "thinking was visible while it streamed, not only once the block closed",
    thinkingSteps === thinkingChunks,
    `${thinkingSteps} visible updates from ${thinkingChunks} chunks, ${thinkBlocks.length} blocks`,
  );
  check(
    "each thinking block cost one line, not one per chunk",
    thinkLines.length === thinkBlocks.length && thinkLines.length <= thinkingChunks,
    `${thinkingChunks} chunks -> ${thinkLines.length} lines (${thinkBlocks.length} blocks)`,
  );
  check(
    "the live and persisted thinking agree",
    thinkBlocks.every(
      (r) =>
        (disk.get(r.recordId)?.event as { text?: string } | undefined)?.text ===
        (r.event as { text: string }).text,
    ),
  );
}

// Turn fences: a reader groups by `msg(user) → activity… → msg(assistant)`.
const shape = lines.filter((l) => l.t !== "meta").map((l) => (l.t === "msg" ? `msg:${l.role}` : l.t));
check(
  "activity stayed inside the turn's msg fences",
  shape[0] === "msg:user" &&
    shape.at(-1) === "msg:assistant" &&
    shape.slice(1, -1).every((t) => t === "activity"),
  shape.join(" "),
);

// Nothing to replay between turns — a settled turn belongs to the transcript.
const snapshot = session.activitySnapshot();
check(
  "the snapshot is idle after the turn",
  snapshot.active === false && snapshot.records.length === 0,
  JSON.stringify({ active: snapshot.active, seq: snapshot.seq, records: snapshot.records.length }),
);

check(
  "messages round-trip",
  (await readTranscript(transcriptPath)).map((m) => m.role).join(",") === "user,assistant",
);

// --- report ---------------------------------------------------------------------------

console.log("");
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

console.log("");
console.log(`tool transport: ${terminalBacked ? "our terminal/* handlers" : "the agent's own execution"}`);
console.log(
  thinkingChunks === 0
    ? "thinking: none this run — the streaming checks were skipped, not passed"
    : `thinking: ${thinkingChunks} chunks -> ${thinkBlocks.length} blocks -> ${thinkLines.length} lines`,
);
console.log(`permission requests: ${permissions}`);
// The wire carries every kind; the transcript carries the `kinds` subset. Name what was
// filtered, so the two counts don't read as a discrepancy.
const wireOnly = [...live.values()]
  .filter((r) => !disk.has(r.recordId))
  .map((r) => r.event.kind);
console.log(
  `records on the wire: ${live.size}   in the transcript: ${disk.size}` +
    (wireOnly.length > 0 ? `   (not persisted by config: ${wireOnly.join(", ")})` : ""),
);
console.log(`workDir=${workDir}`);
console.log(`transcriptPath=${transcriptPath}`);
if (wirePath) console.log(`wirePath=${wirePath}`);

await killPort(port);

console.log(failed === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failed}/${checks.length})`);
process.exit(failed === 0 ? 0 : 1);

// --- helpers --------------------------------------------------------------------------

function toolsOf(records: Map<string, AggregatedRecord>): ToolActivity[] {
  return [...records.values()]
    .map((r) => r.event)
    .filter((e): e is ToolActivity => e.kind === "tool");
}

/** Everything the model has thought so far, as a subscriber would have it on screen. */
function thinkingTextOf(records: Map<string, AggregatedRecord>): string {
  return [...records.values()]
    .map((r) => r.event)
    .filter((e): e is Extract<typeof e, { kind: "thinking" }> => e.kind === "thinking")
    .map((e) => e.text)
    .join("");
}

/** Every string a tool call surfaced — text blocks, terminal output, raw output. */
function collectText(call: ToolActivity): string[] {
  const out: string[] = [];
  if (typeof call.rawOutput === "string") out.push(call.rawOutput);
  for (const entry of call.content ?? []) {
    if (entry.type === "content") {
      if (entry.text) out.push(entry.text);
      const nested = (entry.content as { text?: unknown }).text;
      if (typeof nested === "string") out.push(nested);
    } else if (entry.type === "terminal" && entry.output) {
      out.push(entry.output);
    } else if (entry.type === "diff") {
      out.push(entry.newText);
    }
  }
  return out;
}

/**
 * Compare what the live stream ended up with against what the file says. Deliberately a
 * projection, not deep equality: `rawOutput` is dropped on disk by default (it duplicates
 * `content`), so requiring identity would fail for a reason that is not drift.
 */
function sameCall(streamed: ToolActivity, persisted?: ToolActivity): boolean {
  if (!persisted) return false;
  return (
    streamed.status === persisted.status &&
    streamed.title === persisted.title &&
    JSON.stringify(streamed.rawInput) === JSON.stringify(persisted.rawInput) &&
    JSON.stringify(streamed.content) === JSON.stringify(persisted.content)
  );
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = server.port;
  server.stop(true);
  return chosen;
}

/** Best effort: don't leave a Python server holding a port because the agent forgot to. */
async function killPort(target: number): Promise<void> {
  try {
    const lsof = Bun.spawn(["lsof", "-ti", `tcp:${target}`], { stdout: "pipe", stderr: "ignore" });
    const pids = (await new Response(lsof.stdout).text()).trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) return;
    console.log(`[cleanup] killing leftover listener on ${target}: ${pids.join(", ")}`);
    Bun.spawn(["kill", "-9", ...pids], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log(`[cleanup] could not check port ${target} (lsof missing?) — check it by hand`);
  }
}
