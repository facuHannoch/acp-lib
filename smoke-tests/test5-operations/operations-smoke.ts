#!/usr/bin/env bun
// EXECUTABLE CONSUMER CONTRACT for AgentSession operations.
//
// This is intentionally a smoke test rather than a unit test: it composes the public
// objects exactly as an orchestration consumer does — FileSessionStore, SessionManager,
// AgentSession, transcript storage, a custom adapter, and an ACP subprocess. The harness
// is fake only to make the lifecycle deterministic and free.
//
// The first revision is expected to be RED. Planned APIs are feature-detected and reported
// as missing, so the existing half of the scenario still runs and shows its real behavior.
// Later implementation parts turn those checks green without rewriting the scenario.
//
// Usage:
//   bun smoke-tests/test5-operations/operations-smoke.ts
//
// Exit codes: 0 complete contract passed, 1 missing/broken operation,
//             2 fixture/transport could not start.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  FileSessionStore,
  SessionManager,
  readTranscriptLines,
  type Adapter,
} from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "operations-agent.ts");

await runConsumer();

interface Check {
  area: "catalog" | "session" | "harness" | "transcript";
  name: string;
  ok: boolean;
  detail: string;
}

interface NotificationEnvelope {
  seq: number;
  ts: number;
  agentSessionId: string;
  event: { kind: string; [key: string]: unknown };
}

interface DesiredSessionSurface {
  readonly state: {
    phase: string;
    isBusy: boolean;
    queuedOperationCount: number;
  };
  readonly isBusy: boolean;
  readonly queuedOperationCount: number;
  subscribe(listener: (notification: NotificationEnvelope) => void): () => void;
  executeAgentCommand(name: string, input?: string): Promise<{ text: string }>;
  handoff(options?: { summary?: string }): Promise<{
    handoffId: string;
    agentSessionId: string;
    fromInternalSessionId: string | null;
    toInternalSessionId: string;
    summary: string;
  }>;
}

interface DesiredRestoreSurface {
  restore(options: {
    agentSessionId: string;
    sessions: SessionManager;
    resolveAdapter: (adapterId: string) => Adapter | Promise<Adapter>;
    transcriptDir: string;
  }): Promise<AgentSession>;
}

async function runConsumer(): Promise<void> {
  const debugWire = process.env.OPERATIONS_DEBUG === "1"
    ? (entry: { dir: string; line: string }) => process.stderr.write(`${entry.dir} ${entry.line}\n`)
    : undefined;
  const root = await mkdtemp(join(tmpdir(), "acp-operations-"));
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
  const watchdog = setTimeout(() => {
    void flushAndExit(
      `\nartifacts: ${root}\nresult: INCONCLUSIVE — scenario exceeded ${timeoutMs}ms\n`,
      2,
    );
  }, timeoutMs);
  const catalogDir = join(root, "catalog");
  const transcriptDir = join(root, "transcripts");
  const sessions = new SessionManager(new FileSessionStore(catalogDir));
  const checks: Check[] = [];
  const notifications: NotificationEnvelope[] = [];
  const adapterA = fakeAdapter("consumer-a");
  const adapterB = fakeAdapter("consumer-b");
  const adapters = new Map<string, Adapter>([
    ["fake-a", adapterA],
    ["fake-b", adapterB],
  ]);
  const resolveAdapter = (adapterId: string): Adapter => {
    const adapter = adapters.get(adapterId);
    if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
    return adapter;
  };

  let first: AgentSession | null = null;
  let second: AgentSession | null = null;
  let restored: AgentSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let bootstrapError: string | null = null;

  try {
    first = await AgentSession.create({
      adapter: adapterA,
      adapterId: "fake-a",
      agentSessionId: "consumer-a",
      sessions,
      transcriptDir,
      wire: debugWire,
    });

    const initialInternalId = first.internalSessionId;
    check(checks, "catalog", "new AgentSession records itself", initialInternalId != null,
      `agentSessionId=${first.agentSessionId} internalSessionId=${initialInternalId}`);

    const desired = first as unknown as Partial<DesiredSessionSurface>;
    const hasListener = typeof desired.subscribe === "function";
    check(checks, "session", "notification listener is exposed", hasListener,
      hasListener ? "subscribe(listener) is present" : "missing AgentSession.subscribe(listener)");
    if (hasListener) {
      unsubscribe = desired.subscribe!((notification) => notifications.push(notification));
    }

    const hasState = desired.state != null && typeof desired.isBusy === "boolean" &&
      typeof desired.queuedOperationCount === "number";
    check(checks, "session", "state and busy/queue getters are exposed", hasState,
      hasState
        ? `phase=${desired.state!.phase} busy=${desired.isBusy} queued=${desired.queuedOperationCount}`
        : "missing state, isBusy, or queuedOperationCount");

    const initialCommands = first.agentCommands.map((command) => command.name);
    check(checks, "harness", "commands advertised at session creation are readable",
      initialCommands.includes("status"), initialCommands.join(", ") || "none");

    const firstTurn = await first.prompt("first ordinary turn");
    check(checks, "session", "ordinary prompt works", firstTurn.text.includes("first ordinary turn"),
      JSON.stringify(firstTurn.text));

    const commandsAfterTurn = first.agentCommands.map((command) => command.name);
    check(checks, "harness", "command updates remain readable",
      commandsAfterTurn.includes("status") && commandsAfterTurn.includes("usage"),
      commandsAfterTurn.join(", ") || "none");

    if (hasListener) {
      const kinds = notifications.map((notification) => notification.event.kind);
      check(checks, "session", "turn lifecycle is notified",
        kinds.includes("turn_started") && kinds.includes("turn_completed"),
        kinds.join(" -> ") || "no notifications");
      check(checks, "harness", "command changes are notified",
        kinds.includes("agent_commands_changed"), kinds.join(" -> ") || "no notifications");
      check(checks, "session", "notification envelopes are ordered",
        notifications.every((n, i) =>
          n.agentSessionId === "consumer-a" && n.ts > 0 && (i === 0 || n.seq > notifications[i - 1]!.seq)),
        notifications.map((n) => String(n.seq)).join(", ") || "no notifications");
    }

    const hasExecute = typeof desired.executeAgentCommand === "function";
    check(checks, "harness", "explicit harness command execution is exposed", hasExecute,
      hasExecute ? "executeAgentCommand(name, input?) is present" : "missing executeAgentCommand");
    if (hasExecute) {
      const status = await desired.executeAgentCommand!("status");
      check(checks, "harness", "advertised command reaches the harness",
        status.text.includes("FAKE_STATUS"), JSON.stringify(status.text));
    }

    const hasHandoff = typeof desired.handoff === "function";
    check(checks, "session", "handoff is exposed", hasHandoff,
      hasHandoff ? "handoff(options?) is present" : "missing AgentSession.handoff(options?)");
    if (hasHandoff) {
      const handoff = await desired.handoff!({ summary: "portable continuation context" });
      check(checks, "session", "handoff preserves logical identity",
        first.agentSessionId === "consumer-a" && handoff.agentSessionId === first.agentSessionId,
        `session=${first.agentSessionId} result=${handoff.agentSessionId}`);
      check(checks, "session", "handoff replaces only the internal session",
        handoff.fromInternalSessionId === initialInternalId &&
          handoff.toInternalSessionId === first.internalSessionId &&
          handoff.toInternalSessionId !== initialInternalId,
        `${handoff.fromInternalSessionId} -> ${handoff.toInternalSessionId}`);

      const record = await sessions.get("consumer-a");
      check(checks, "catalog", "handoff updates the same catalog record",
        record?.agentSessionId === "consumer-a" && record.internalSessionId === first.internalSessionId,
        record ? `${record.agentSessionId} -> ${record.internalSessionId}` : "record missing");

      if (hasListener) {
        const kinds = notifications.map((notification) => notification.event.kind);
        check(checks, "session", "handoff lifecycle is notified",
          kinds.includes("handoff_started") && kinds.includes("handoff_completed"),
          kinds.join(" -> "));
      }
    }

    second = await AgentSession.create({
      adapter: adapterB,
      adapterId: "fake-b",
      agentSessionId: "consumer-b",
      sessions,
      transcriptDir,
      wire: debugWire,
    });
    const catalog = await sessions.list();
    check(checks, "catalog", "consumer can list multiple logical sessions",
      catalog.length === 2 && catalog.some((r) => r.agentSessionId === "consumer-a") &&
        catalog.some((r) => r.agentSessionId === "consumer-b"),
      catalog.map((r) => r.agentSessionId).join(", "));

    const transcriptPath = join(transcriptDir, "consumer-a.jsonl");
    const lines = await readTranscriptLines(transcriptPath);
    const handoffLines = lines.filter((line) => line.t === "handoff");
    check(checks, "transcript", "logical transcript contains a handoff boundary",
      hasHandoff && handoffLines.length >= 2,
      hasHandoff ? `${handoffLines.length} handoff lines` : "handoff API not implemented");

    unsubscribe?.();
    unsubscribe = null;
    await first.stop();
    first = null;

    const restoreSurface = AgentSession as unknown as Partial<DesiredRestoreSurface>;
    const hasRestore = typeof restoreSurface.restore === "function";
    check(checks, "catalog", "AgentSession restoration is exposed", hasRestore,
      hasRestore ? "AgentSession.restore(options) is present" : "missing AgentSession.restore(options)");
    if (hasRestore) {
      restored = await restoreSurface.restore!({
        agentSessionId: "consumer-a",
        sessions,
        resolveAdapter,
        transcriptDir,
      });
      const record = await sessions.get("consumer-a");
      check(checks, "catalog", "restoration retains logical and internal identity",
        restored.agentSessionId === "consumer-a" && restored.internalSessionId === record?.internalSessionId,
        `restored=${restored.agentSessionId}/${restored.internalSessionId} catalog=${record?.internalSessionId}`);
    }
  } catch (error) {
    if (!first && checks.length === 0) bootstrapError = String(error);
    else check(checks, "session", "scenario completed without an unexpected exception", false, String(error));
  } finally {
    unsubscribe?.();
    await Promise.allSettled([first?.stop(), second?.stop(), restored?.stop()].filter(Boolean));
  }

  clearTimeout(watchdog);
  await report(checks, root, bootstrapError);
}

function fakeAdapter(label: string): Adapter {
  return {
    command: ["bun", FAKE_AGENT, label],
    displayName: `Fake ACP (${label})`,
  };
}

function check(
  checks: Check[],
  area: Check["area"],
  name: string,
  ok: boolean,
  detail: string,
): void {
  checks.push({ area, name, ok, detail });
}

async function report(checks: Check[], root: string, bootstrapError: string | null): Promise<never> {
  const output: string[] = [];
  const areas: Check["area"][] = ["catalog", "session", "harness", "transcript"];
  for (const area of areas) {
    output.push("", area.toUpperCase());
    for (const result of checks.filter((candidate) => candidate.area === area)) {
      output.push(`${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
    }
  }
  const failures = checks.filter((result) => !result.ok);
  output.push("", `artifacts: ${root}`);
  output.push(
    bootstrapError
      ? `result: INCONCLUSIVE — fixture/transport did not start: ${bootstrapError}`
      : `result: ${checks.length - failures.length}/${checks.length} checks passed`,
    "",
  );
  // ACP's stream readers can retain an event-loop handle briefly after SIGTERM. Flush the
  // complete report explicitly, then exit with the contract status; a bare process.exit()
  // can otherwise discard Bun's buffered stdout and a passive exit can hang indefinitely.
  await flushAndExit(
    output.join("\n"),
    bootstrapError ? 2 : failures.length === 0 ? 0 : 1,
  );
}

async function flushAndExit(output: string, exitCode: number): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
  process.exit(exitCode);
}
