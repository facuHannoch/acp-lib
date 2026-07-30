#!/usr/bin/env bun
// END-TO-END SMOKE TEST against real Kimi: make the agent stand up a Python HTTP server,
// curl it, and report the status code. Small task, but it needs everything the library
// promises for a working tool call — write a file, run commands, read their output back —
// so the failure modes it catches are the ones that matter:
//
//   - tool output never reaching the caller (the `{}` tool block bug)
//   - a settled transcript that disagrees with what was streamed live (fold drift)
//   - activity lines multiplying per notification instead of per lifecycle step
//   - msg/activity ordering breaking the turn fences a reader groups by
//
// It checks the library, not the model: the pass condition is that OUR stream carried the
// evidence, not that the agent phrased its answer nicely.
//
// Usage:
//   bun smoke-tests/test2/kimi-http-smoke.ts
//   bun smoke-tests/test2/kimi-http-smoke.ts --wire          # raw protocol to a file
//   bun smoke-tests/test2/kimi-http-smoke.ts --wire=stderr   # raw protocol to the console
//   KIMI_SMOKE_TIMEOUT_MS=300000 bun smoke-tests/test2/kimi-http-smoke.ts
//
// Requires `kimi` on PATH (an authenticated Kimi CLI), plus python3 and curl.

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
  type ToolActivity,
} from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const timeoutMs = Number(process.env.KIMI_SMOKE_TIMEOUT_MS ?? 240_000);
const port = await freePort();

const chatsDir = join(here, "chats");
await mkdir(chatsDir, { recursive: true });
const stamp = Date.now();
const transcriptPath = join(chatsDir, `kimi-http-${stamp}.jsonl`);

// --wire dumps every raw protocol line. The file form is the useful one here: to stderr it
// interleaves with the streamed reply.
const wireArg = process.argv.find((a) => a === "--wire" || a.startsWith("--wire="));
const wirePath = wireArg === "--wire" ? join(chatsDir, `kimi-http-${stamp}.wire.jsonl`) : null;
const wire = !wireArg
  ? undefined
  : wireArg === "--wire"
    ? createWireLog({ path: wirePath! })
    : createWireLog({ console: "stderr" });

// The agent works in a throwaway directory, never the repo.
const workDir = await mkdtemp(join(tmpdir(), "kimi-http-smoke-"));

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

console.log(`workDir=${workDir}`);
console.log(`port=${port}`);
console.log(`transcriptPath=${transcriptPath}\n`);

const session = await AgentSession.create({
  adapter: ADAPTERS.kimi,
  adapterId: "kimi",
  cwd: workDir,
  transcriptPath,
  transcriptActivity: true,
  defaultPermission: "approve",
  logger: createConsoleLogger({ minLevel: "warn" }),
  wire,
});

/** Everything the LIVE stream said, folded exactly the way a browser client would. */
const live = new Map<string, AggregatedRecord>();
let rawEvents = 0;
let permissions = 0;
let terminalBacked = false;

const timer = setTimeout(() => {
  console.error(`\n[timeout] no result after ${timeoutMs}ms — interrupting`);
  session.interrupt({ clearQueue: true });
}, timeoutMs);

let result;
try {
  result = await session.prompt(prompt, {
    onChunk: (text) => process.stdout.write(text),
    onActivity: (event) => {
      rawEvents++;
      if (event.kind === "tool" || event.kind === "tool_update") {
        for (const entry of event.content ?? []) {
          if (entry.type === "terminal") terminalBacked = true;
        }
      }
    },
    onRecord: (r) => {
      for (const frame of wireFrames(r)) foldFrame(live, frame);
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
} finally {
  clearTimeout(timer);
  await session.stop();
}

if (!result.text.endsWith("\n")) process.stdout.write("\n");

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
