#!/usr/bin/env bun
// Reports the versions of the agent binaries the ADAPTERS presets (src/adapters.ts) spawn,
// compares them to what their publishers currently ship, and optionally updates them.
//
// The presets are bare command names — this repo neither depends on nor pins those binaries,
// so "keeping adapters current" is a separate, explicit act. This script is that act.
//
// Usage:
//   bun run adapters:check                 # report current vs latest, change nothing
//   bun run adapters:update                # update every tracked adapter
//   bun run adapters:update --only codex,pi
//   bun run adapters:update --dry-run
//   bun run adapters:check --json
//
// Exit code (check mode): 1 if any tracked adapter is outdated, missing, or of unknown
// version — 0 only when every tracked adapter is current. Update mode exits non-zero on the
// first failed update.

import { ADAPTERS } from "../src/adapters.ts";

type UpdateStrategy =
  | { readonly kind: "npm"; readonly pkg: string }
  | { readonly kind: "command"; readonly argv: readonly string[] };

interface TrackedAdapter {
  /** Key in ADAPTERS, so drift between this table and the presets is detectable. */
  readonly preset: keyof typeof ADAPTERS;
  /** The binary the preset actually spawns; must equal ADAPTERS[preset].command[0]. */
  readonly binary: string;
  /**
   * npm package that publishes the binary, or null when the tool updates itself and its
   * version is only knowable by running it.
   */
  readonly pkg: string | null;
  readonly update: UpdateStrategy;
  readonly note?: string;
}

const TRACKED: readonly TrackedAdapter[] = [
  {
    preset: "codex",
    binary: "codex-acp",
    pkg: "@agentclientprotocol/codex-acp",
    update: { kind: "npm", pkg: "@agentclientprotocol/codex-acp" },
  },
  {
    preset: "claude",
    binary: "claude-agent-acp",
    pkg: "@agentclientprotocol/claude-agent-acp",
    update: { kind: "npm", pkg: "@agentclientprotocol/claude-agent-acp" },
  },
  {
    preset: "pi",
    binary: "pi-acp",
    pkg: "@automatalabs/pi-acp",
    update: { kind: "npm", pkg: "@automatalabs/pi-acp" },
  },
  {
    preset: "opencode",
    binary: "opencode",
    pkg: "opencode-ai",
    update: { kind: "command", argv: ["opencode", "upgrade"] },
  },
  {
    preset: "kimi",
    binary: "kimi",
    pkg: null,
    update: { kind: "command", argv: ["kimi", "upgrade"] },
  },
  {
    preset: "claudeCode",
    binary: "claude-code-acp",
    pkg: "@zed-industries/claude-code-acp",
    update: { kind: "npm", pkg: "@zed-industries/claude-code-acp" },
    note: "deprecated — prefer the `claude` preset",
  },
];

type Status = "current" | "outdated" | "ahead" | "missing" | "unknown";

interface Report {
  readonly preset: string;
  readonly binary: string;
  readonly pkg: string | null;
  readonly current: string | null;
  readonly latest: string | null;
  readonly status: Status;
  readonly note?: string;
}

const SEMVER = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

function run(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [...argv],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

/** Global npm installs, keyed by package name. One `npm ls` covers every npm-backed entry. */
function npmGlobalVersions(): Map<string, string> {
  const result = run(["npm", "ls", "-g", "--depth=0", "--json"]);
  const versions = new Map<string, string>();
  if (result.code !== 0 && !result.stdout) return versions;
  try {
    const parsed = JSON.parse(result.stdout) as {
      dependencies?: Record<string, { version?: string }>;
    };
    for (const [name, value] of Object.entries(parsed.dependencies ?? {})) {
      if (value?.version) versions.set(name, value.version);
    }
  } catch {
    // A malformed `npm ls` should degrade to "unknown", not crash the report.
  }
  return versions;
}

/** Ask the binary itself; the only route for self-updating tools. */
function binaryVersion(binary: string): string | null {
  if (Bun.which(binary) === null) return null;
  const result = run([binary, "--version"]);
  const match = (result.stdout || result.stderr).match(SEMVER);
  return match ? match[1] : null;
}

async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

function classify(current: string | null, latest: string | null): Status {
  if (current === null) return "missing";
  if (latest === null) return "unknown";
  const order = Bun.semver.order(current, latest);
  if (order === 0) return "current";
  return order < 0 ? "outdated" : "ahead";
}

async function collect(): Promise<Report[]> {
  const npm = npmGlobalVersions();
  return Promise.all(
    TRACKED.map(async (entry) => {
      const current = entry.pkg ? npm.get(entry.pkg) ?? null : binaryVersion(entry.binary);
      const latest = entry.pkg ? await latestVersion(entry.pkg) : null;
      return {
        preset: entry.preset,
        binary: entry.binary,
        pkg: entry.pkg,
        current,
        latest,
        status: classify(current, latest),
        note: entry.note,
      };
    }),
  );
}

function warnAboutDrift(): void {
  for (const entry of TRACKED) {
    const expected = ADAPTERS[entry.preset]?.command?.[0];
    if (expected !== entry.binary) {
      console.warn(
        `warning: preset "${entry.preset}" spawns "${expected}" but this script tracks ` +
          `"${entry.binary}" — update scripts/adapters.ts to match src/adapters.ts`,
      );
    }
  }
}

const MARKERS: Record<Status, string> = {
  current: "up to date",
  outdated: "OUTDATED",
  ahead: "ahead of npm",
  missing: "NOT INSTALLED",
  unknown: "unknown",
};

function printTable(reports: readonly Report[]): void {
  const rows = reports.map((r) => ({
    preset: r.preset,
    binary: r.binary,
    current: r.current ?? "-",
    latest: r.latest ?? "-",
    status: MARKERS[r.status],
    note: r.note ?? "",
  }));
  const headers = ["preset", "binary", "current", "latest", "status", "note"] as const;
  const width = (key: (typeof headers)[number]) =>
    Math.max(key.length, ...rows.map((row) => row[key].length));
  const pad = (value: string, size: number) => value.padEnd(size);

  console.log(
    headers.map((h) => pad(h, width(h))).join("  ").trimEnd(),
  );
  console.log(headers.map((h) => "-".repeat(width(h))).join("  ").trimEnd());
  for (const row of rows) {
    console.log(headers.map((h) => pad(row[h], width(h))).join("  ").trimEnd());
  }
}

async function update(reports: readonly Report[], dryRun: boolean): Promise<number> {
  let failures = 0;
  for (const report of reports) {
    const entry = TRACKED.find((candidate) => candidate.preset === report.preset)!;
    const argv =
      entry.update.kind === "npm"
        ? ["npm", "i", "-g", `${entry.update.pkg}@latest`]
        : [...entry.update.argv];
    const label = argv.join(" ");

    if (report.status === "current" && !dryRun) {
      console.log(`skip   ${report.preset}: already at ${report.current}`);
      continue;
    }
    if (dryRun) {
      console.log(`would  ${report.preset}: ${label}`);
      continue;
    }

    console.log(`update ${report.preset}: ${label}`);
    const result = run(argv);
    if (result.code !== 0) {
      failures += 1;
      console.error(`  failed (exit ${result.code})`);
      if (result.stderr) console.error(`  ${result.stderr.split("\n").join("\n  ")}`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes("--update") || args[0] === "update" ? "update" : "check";
  const dryRun = args.includes("--dry-run");
  const asJson = args.includes("--json");
  const only = (() => {
    const inline = args.find((arg) => arg.startsWith("--only="));
    if (inline) return inline.slice("--only=".length).split(",").map((s) => s.trim());
    const index = args.indexOf("--only");
    if (index >= 0 && args[index + 1]) return args[index + 1].split(",").map((s) => s.trim());
    return null;
  })();

  warnAboutDrift();

  let reports = await collect();
  if (only) reports = reports.filter((report) => only.includes(report.preset));

  if (mode === "update") {
    const failures = await update(reports, dryRun);
    if (dryRun) return;
    console.log("\nre-checking after update:\n");
    reports = await collect();
    if (only) reports = reports.filter((report) => only.includes(report.preset));
    printTable(reports);
    if (failures > 0) process.exit(1);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    printTable(reports);
  }

  const stale = reports.filter((r) => r.status === "outdated" || r.status === "missing");
  if (stale.length > 0) {
    console.log(`\n${stale.length} adapter(s) need attention. Run: bun run adapters:update`);
    process.exit(1);
  }
}

await main();
