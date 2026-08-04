#!/usr/bin/env bun
// END-TO-END SMOKE TEST for PERMISSIONS — and, first of all, an INSTRUMENT.
//
// The 0.3.2 fix stopped picking `options[0]` and started picking by `kind` (`allow_once`,
// falling back to `allow_always`). That fix is only correct if agents actually populate
// `kind` with the strings the ACP schema names. The unit tests cannot prove that: they use
// a fixture that sends what the schema says, so they verify our logic against our own
// assumption. This runs real agents and prints what they REALLY send, verbatim.
//
// So every option every agent offers is dumped before any judgement is made. If an agent
// invents its own kind string, or omits `kind`, or labels an allow option something
// unexpected, that shows up as data here rather than as a silent cancel in production.
//
// TWO SCENARIOS, because agents gate them differently:
//   builtin — the agent's own file-write tool.
//   mcp     — a tool from an MCP server we bind at session/new. This is the path the bug
//             was reported on, and an agent may treat third-party tools quite unlike its
//             own. Testing only the built-in path would have proved the wrong thing.
//
// The last check in each is the one that matters most: the side effect has to be visible
// ON DISK afterwards. Protocol shape can look like an approval while the call was never
// made, and only the filesystem knows which happened.
//
// Usage:
//   bun smoke-tests/test4-permission/permission-smoke.ts             # every agent on PATH
//   bun smoke-tests/test4-permission/permission-smoke.ts claude
//   bun smoke-tests/test4-permission/permission-smoke.ts --only=mcp
//   bun smoke-tests/test4-permission/permission-smoke.ts --wire      # keep raw protocol
//   SMOKE_TIMEOUT_MS=300000 bun smoke-tests/test4-permission/permission-smoke.ts
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 nothing could run.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  AgentSession,
  createConsoleLogger,
  createWireLog,
  type WireEntry,
} from "../../src/index.ts";

type AgentId = keyof typeof ADAPTERS;

// Claude Code refuses to start inside another Claude Code session, and says so only on
// stderr. Same reasoning as test3: this is a test script, and the transport spawns agents
// with `{...process.env, ...env}`.
delete process.env.CLAUDECODE;

/** The four kinds the ACP schema defines. Anything else is a finding, not an error. */
const KNOWN_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;
const ALLOW_KINDS = ["allow_once", "allow_always"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(here, "marker-mcp-server.ts");
const TARGET_FILE = "hello.txt";
const TARGET_TEXT = "hi";
const SHELL_FILE = "shell.txt";
const MARKER_VALUE = "smoke-marker-42";

// --- scenarios ----------------------------------------------------------------------------

interface ScenarioContext {
  workDir: string;
  markerPath: string;
}

interface Scenario {
  id: string;
  label: string;
  /** Bind the MCP server over ACP, at session/new. */
  mcp: boolean;
  /** Instead, drop a project-scoped `.mcp.json` in the workspace and bind nothing. */
  mcpJson?: boolean;
  prompt: (ctx: ScenarioContext) => string;
  /** Ground truth: did the tool's side effect actually land? */
  verify: (ctx: ScenarioContext) => Promise<{ ok: boolean; detail: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "builtin",
    label: "the agent's own write tool",
    mcp: false,
    // Explicit about path and content so "it never asked" can never be confused with
    // "it misunderstood the request".
    prompt: () =>
      `Create a file named ${TARGET_FILE} in the current directory containing exactly the text: ${TARGET_TEXT}\n` +
      `Do not ask me anything first. Do not create any other file.`,
    verify: async ({ workDir }) => {
      try {
        const content = await readFile(join(workDir, TARGET_FILE), "utf8");
        return {
          ok: content.toLowerCase().includes(TARGET_TEXT),
          detail: JSON.stringify(content.slice(0, 40)),
        };
      } catch {
        return { ok: false, detail: `${TARGET_FILE} was never created` };
      }
    },
  },
  {
    id: "shell",
    label: "the agent's shell/execute tool",
    mcp: false,
    // A third tool KIND, because the option list is the agent's to build per call and
    // nothing says it is stable across tools — shell is the one agents gate hardest.
    prompt: () =>
      `Run this exact shell command and nothing else: printf 'ran' > ${SHELL_FILE}\n` +
      `Do not ask me anything first. Do not use a file-writing tool — use the shell.`,
    verify: async ({ workDir }) => {
      try {
        const content = await readFile(join(workDir, SHELL_FILE), "utf8");
        return { ok: content.includes("ran"), detail: JSON.stringify(content.slice(0, 40)) };
      } catch {
        return { ok: false, detail: `${SHELL_FILE} was never created` };
      }
    },
  },
  {
    id: "mcp",
    label: "a tool from a bound MCP server",
    mcp: true,
    prompt: () =>
      `Use the record_marker tool to record the marker value ${MARKER_VALUE}.\n` +
      `Do not ask me anything first. Use the tool — do not just describe it.`,
    verify: async ({ markerPath }) => {
      try {
        const content = await readFile(markerPath, "utf8");
        return { ok: content.includes(MARKER_VALUE), detail: JSON.stringify(content.trim()) };
      } catch {
        return { ok: false, detail: "the MCP tool never ran" };
      }
    },
  },
  {
    id: "mcp-json",
    label: "an MCP server from a project-scoped .mcp.json (bound by the AGENT, not by us)",
    mcp: false,
    mcpJson: true,
    // The configuration a consumer actually ships. A server the agent discovers for itself
    // is trusted on the agent's own terms, and that decision may never cross ACP at all —
    // in which case `defaultPermission` cannot reach it, whatever it is set to.
    prompt: () =>
      `Use the record_marker tool to record the marker value ${MARKER_VALUE}.\n` +
      `Do not ask me anything first. Use the tool — do not just describe it.`,
    verify: async ({ markerPath }) => {
      try {
        const content = await readFile(markerPath, "utf8");
        return { ok: content.includes(MARKER_VALUE), detail: JSON.stringify(content.trim()) };
      } catch {
        return { ok: false, detail: "the MCP tool never ran" };
      }
    },
  },
];

// --- what we observed ----------------------------------------------------------------------

interface PermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

/** One `session/request_permission` and the answer we put back on the wire. */
interface Exchange {
  id: string | number;
  options: PermissionOption[];
  /** Kept so a surprise field is visible rather than an unexplained failure. */
  rawRequest: any;
  outcome?: string;
  chosenId?: string;
  /** Resolved from `chosenId` against `options` — what we actually granted. */
  chosenKind?: string;
  chosenName?: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Report {
  agent: AgentId;
  scenario: string;
  status: "ok" | "failed" | "skipped" | "error";
  checks: Check[];
  exchanges: Exchange[];
  note?: string;
  lines: string[];
}

/**
 * Reconstruct the permission exchanges from raw wire traffic rather than from a handler.
 *
 * Deliberate: with no `onPermissionRequest` the LIBRARY's own default path answers, which
 * is the code the fix changed. A handler here would replace that code with test code and
 * prove nothing. The wire is the only place both halves are visible.
 */
function makeWireWatcher(): {
  wire: (e: WireEntry) => void;
  exchanges: Exchange[];
  stderr: string[];
} {
  const exchanges: Exchange[] = [];
  const byId = new Map<string | number, Exchange>();
  const stderr: string[] = [];

  const wire = (entry: WireEntry) => {
    if (entry.dir === "err") {
      stderr.push(entry.line);
      if (stderr.length > 25) stderr.shift();
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(entry.line);
    } catch {
      return; // not JSON — agents write banners to stdout occasionally
    }

    if (entry.dir === "in" && msg?.method === "session/request_permission") {
      const exchange: Exchange = {
        id: msg.id,
        options: Array.isArray(msg.params?.options) ? msg.params.options : [],
        rawRequest: msg.params,
      };
      exchanges.push(exchange);
      byId.set(msg.id, exchange);
      return;
    }

    // Our reply. A response has an id and NO method — that is what separates it from our
    // own outgoing requests, whose ids live in a different space and can collide.
    if (entry.dir === "out" && msg?.id != null && msg.method === undefined) {
      const exchange = byId.get(msg.id);
      if (!exchange) return;
      const outcome = msg.result?.outcome;
      exchange.outcome = outcome?.outcome ?? (msg.error ? "error" : "unknown");
      exchange.chosenId = outcome?.optionId;
      const option = exchange.options.find((o) => o.optionId === outcome?.optionId);
      exchange.chosenKind = option?.kind;
      exchange.chosenName = option?.name;
    }
  };

  return { wire, exchanges, stderr };
}

// --- setup ---------------------------------------------------------------------------------

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const args = process.argv.slice(2);
const wantWire = args.some((a) => a === "--wire");
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const scenarios = onlyArg ? SCENARIOS.filter((s) => s.id === onlyArg) : SCENARIOS;
if (scenarios.length === 0) {
  console.error(`unknown scenario: ${onlyArg}`);
  console.error(`known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const chatsDir = join(here, "chats");
await mkdir(chatsDir, { recursive: true });

const requested = args.filter((a) => !a.startsWith("-"));
for (const name of requested) {
  if (!(name in ADAPTERS)) {
    console.error(`unknown agent: ${name}`);
    console.error(`known: ${Object.keys(ADAPTERS).join(", ")}`);
    process.exit(2);
  }
}
const candidates = (requested.length > 0 ? requested : Object.keys(ADAPTERS)) as AgentId[];
/**
 * npm package behind an adapter whose binary is often not installed globally. Lets the test
 * run an agent the machine hasn't got, via `bunx`, instead of skipping it — which for
 * `claude` matters, since it is the agent the permission bug was reported against and a
 * skip would read as a pass.
 */
const NPM_PACKAGE: Partial<Record<AgentId, string>> = {
  claude: "@agentclientprotocol/claude-agent-acp",
};

/** The adapter as configured, or a `bunx` equivalent when its binary isn't on PATH. */
function resolve(id: AgentId): (typeof ADAPTERS)[AgentId] | null {
  const adapter = ADAPTERS[id];
  if (Bun.which(adapter.command[0]!) !== null) return adapter;
  const pkg = NPM_PACKAGE[id];
  if (pkg && Bun.which("bunx") !== null) return { ...adapter, command: ["bunx", pkg] };
  return null;
}

const resolved = new Map(candidates.map((id) => [id, resolve(id)] as const));
const available = candidates.filter((id) => resolved.get(id) != null);
const missing = candidates.filter((id) => !available.includes(id));

if (available.length === 0) {
  console.error(`none of the requested agents are on PATH: ${candidates.join(", ")}`);
  console.error(candidates.map((id) => `  ${id} -> ${ADAPTERS[id].command.join(" ")}`).join("\n"));
  process.exit(2);
}

// --- one agent, one scenario ------------------------------------------------------------------

async function run(agent: AgentId, scenario: Scenario): Promise<Report> {
  const tag = `${agent}/${scenario.id}`;
  const stamp = Date.now();
  const base = `${agent}-permission-${scenario.id}-${stamp}`;
  const transcriptPath = join(chatsDir, `${base}.jsonl`);
  const wirePath = wantWire ? join(chatsDir, `${base}.wire.jsonl`) : null;
  const lines: string[] = [];
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const workDir = await mkdtemp(join(tmpdir(), `${agent}-${scenario.id}-`));
  const ctx: ScenarioContext = { workDir, markerPath: join(workDir, "marker.txt") };

  if (scenario.mcpJson) {
    await writeFile(
      join(workDir, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            marker: {
              command: process.execPath,
              args: [MCP_SERVER],
              env: { MCP_MARKER_FILE: ctx.markerPath },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const { wire: watch, exchanges, stderr } = makeWireWatcher();
  const sink = wirePath ? createWireLog({ path: wirePath }) : undefined;
  const wire = (entry: WireEntry) => {
    watch(entry);
    sink?.(entry);
  };

  const fail = (note: string): Report => ({
    agent,
    scenario: scenario.id,
    status: "error",
    checks,
    exchanges,
    note: [note, ...stderr.slice(-8).map((l) => `  stderr: ${l}`)].join("\n  "),
    lines,
  });

  console.log(`[${tag}] starting`);

  let session: AgentSession;
  try {
    session = await AgentSession.create({
      adapter: resolved.get(agent)!,
      adapterId: agent,
      cwd: workDir,
      transcriptPath,
      // The whole point: no onPermissionRequest, so the library's own approve path answers.
      defaultPermission: "approve",
      mcpServers: scenario.mcp
        ? [
            {
              name: "marker",
              command: process.execPath, // bun, so the fixture runs without a shebang dance
              args: [MCP_SERVER],
              env: [{ name: "MCP_MARKER_FILE", value: ctx.markerPath }],
            },
          ]
        : undefined,
      logger: createConsoleLogger({ minLevel: "error" }),
      wire,
    });
  } catch (err) {
    console.log(`[${tag}] could not start`);
    return fail(`could not start a session: ${err instanceof Error ? err.message : String(err)}`);
  }
  lines.push(`workdir: ${workDir}`);

  const timer = setTimeout(() => {
    console.log(`[${tag}] timeout after ${timeoutMs}ms — interrupting`);
    session.interrupt({ clearQueue: true });
  }, timeoutMs);

  try {
    await session.prompt(scenario.prompt(ctx));
  } catch (err) {
    clearTimeout(timer);
    await session.stop().catch(() => {});
    return fail(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);
  await session.stop().catch(() => {});

  // --- what actually happened -------------------------------------------------------------

  const truth = await scenario.verify(ctx);

  if (exchanges.length === 0) {
    // Not a failure of ours. An agent is free to decide a tool needs no approval, and some
    // run a sandbox that never routes it through the client at all. Still report whether
    // the work got done, so "never asked" and "never ran" stay distinguishable.
    lines.push(
      `never asked for permission — nothing to check (tool side effect: ${truth.ok ? "landed" : "MISSING"}, ${truth.detail})`,
    );
    return { agent, scenario: scenario.id, status: "skipped", checks, exchanges, lines };
  }

  check("agent asked for permission", true, `${exchanges.length} request(s)`);

  const allOptions = exchanges.flatMap((e) => e.options);
  check(
    "every request offered options",
    exchanges.every((e) => e.options.length > 0),
    exchanges.map((e) => `${e.options.length}`).join(", "),
  );

  // THE POINT OF THIS TEST. Our selection keys on `kind`; if an agent spells them
  // differently, the fix silently degrades to "cancel" and MCP breaks again, quietly.
  const unknownKinds = [
    ...new Set(allOptions.map((o) => o.kind).filter((k) => !KNOWN_KINDS.includes(k as any))),
  ];
  check(
    "all option kinds are ACP-standard",
    unknownKinds.length === 0,
    unknownKinds.length
      ? `UNRECOGNIZED: ${unknownKinds.map((k) => JSON.stringify(k)).join(", ")}`
      : KNOWN_KINDS.join("/"),
  );

  const withAllow = exchanges.filter((e) =>
    e.options.some((o) => ALLOW_KINDS.includes(o.kind as any)),
  );
  check(
    "every request offered an allow option",
    withAllow.length === exchanges.length,
    `${withAllow.length}/${exchanges.length}`,
  );

  const answered = exchanges.filter((e) => e.outcome !== undefined);
  check(
    "we answered every request",
    answered.length === exchanges.length,
    `${answered.length}/${exchanges.length}`,
  );

  // The regression, stated exactly: approve must not come back as a refusal.
  const selected = exchanges.filter((e) => e.outcome === "selected");
  check(
    "approve selected an option (did not cancel)",
    selected.length === exchanges.length,
    exchanges.map((e) => e.outcome ?? "no answer").join(", "),
  );
  check(
    "every option we selected is an ALLOW option",
    selected.length > 0 && selected.every((e) => ALLOW_KINDS.includes(e.chosenKind as any)),
    selected.map((e) => `${e.chosenKind ?? "?"}(${e.chosenName ?? e.chosenId ?? "?"})`).join(", "),
  );

  // `allow_always` writes a durable rule into the agent's own settings, so preferring it
  // would turn one auto-approval into standing policy.
  const bothOffered = exchanges.filter(
    (e) =>
      e.options.some((o) => o.kind === "allow_once") &&
      e.options.some((o) => o.kind === "allow_always"),
  );
  if (bothOffered.length > 0) {
    check(
      "preferred allow_once over allow_always",
      bothOffered.every((e) => e.chosenKind === "allow_once"),
      bothOffered.map((e) => e.chosenKind ?? "?").join(", "),
    );
  }

  check("the approved tool actually ran", truth.ok, truth.detail);

  const failed = checks.filter((c) => !c.ok).length;
  return {
    agent,
    scenario: scenario.id,
    status: failed === 0 ? "ok" : "failed",
    checks,
    exchanges,
    lines,
  };
}

// --- run them all --------------------------------------------------------------------------

console.log(
  `running: ${available.join(", ")}${missing.length ? `  (not on PATH: ${missing.join(", ")})` : ""}`,
);
for (const s of scenarios) console.log(`scenario ${s.id}: ${s.label}`);
console.log("");

const jobs = available.flatMap((agent) => scenarios.map((s) => ({ agent, scenario: s })));
const reports = await Promise.all(jobs.map(({ agent, scenario }) => run(agent, scenario)));

// --- report ----------------------------------------------------------------------------------

let failedRuns = 0;
let asked = 0;

for (const report of reports) {
  const heading = `${report.agent} / ${report.scenario}  [${report.status}]`;
  console.log(`\n${"=".repeat(72)}\n${heading}\n${"=".repeat(72)}`);
  for (const line of report.lines) console.log(`  ${line}`);
  if (report.note) console.log(`  ${report.note}`);

  // Verbatim, before any interpretation — this is the observation the test exists for.
  for (const [i, exchange] of report.exchanges.entries()) {
    asked++;
    const title = exchange.rawRequest?.toolCall?.title ?? exchange.rawRequest?.title ?? "";
    console.log(`\n  request ${i + 1}${title ? `  (${title})` : ""} — options in the order sent:`);
    for (const option of exchange.options) {
      const mark = option.optionId === exchange.chosenId ? "->" : "  ";
      console.log(
        `   ${mark} kind=${JSON.stringify(option.kind)}  optionId=${JSON.stringify(option.optionId)}  name=${JSON.stringify(option.name)}`,
      );
    }
    console.log(
      `      we answered: ${exchange.outcome ?? "(no answer seen)"}${exchange.chosenId ? ` -> ${exchange.chosenId}` : ""}`,
    );
  }

  if (report.checks.length > 0) console.log("");
  for (const c of report.checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  }
  if (report.status === "failed" || report.status === "error") failedRuns++;
}

// Cross-provider view: the naming differences are the finding, so put them side by side.
console.log(`\n${"=".repeat(72)}\noption kinds by agent and scenario\n${"=".repeat(72)}`);
for (const report of reports) {
  const kinds = [
    ...new Set(report.exchanges.flatMap((e) => e.options.map((o) => String(o.kind)))),
  ];
  const ids = [...new Set(report.exchanges.flatMap((e) => e.options.map((o) => String(o.optionId))))];
  const label = `${report.agent}/${report.scenario}`.padEnd(16);
  console.log(`  ${label} kinds: ${kinds.join(", ") || "(never asked)"}`);
  console.log(`  ${" ".repeat(16)} ids:   ${ids.join(", ") || "-"}`);
}

if (asked === 0) {
  console.log(`\nSMOKE INCONCLUSIVE — no agent asked for permission, so nothing was exercised`);
  process.exit(2);
}

console.log(`\n${failedRuns === 0 ? "ALL RUNS PASSED" : `${failedRuns} RUN(S) FAILED`}`);
process.exit(failedRuns === 0 ? 0 : 1);
