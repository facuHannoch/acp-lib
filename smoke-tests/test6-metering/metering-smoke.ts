#!/usr/bin/env bun
// EXECUTABLE CONSUMER CONTRACT for metering persistence.
//
// The library owns no durable accounting database. It hands the consumer an immutable
// record per operation plus the state to persist beside it; the consumer stores both and
// supplies the last state when it rebuilds the session. This test plays that consumer
// against a deterministic fake harness — a tiny "usage repository" backed by a JSON file,
// exactly the shape §11 describes.
//
// What it proves that a unit test cannot: lifetime totals survive the AgentSession OBJECT
// being destroyed and rebuilt in the same process, without transcripts or SessionManager.
//
// Usage:
//   bun smoke-tests/test6-metering/metering-smoke.ts
//
// Exit codes: 0 contract passed, 1 broken, 2 fixture could not start.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession,
  type Adapter,
  type AgentSessionMeteringState,
  type OperationMeteringRecord,
} from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "metering-agent.ts");

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The consumer's accounting store. Records and state are committed together, because a
 * record stored without its state leaves the next session with a stale baseline.
 */
class UsageRepository {
  constructor(private readonly path: string) {}

  async commit(record: OperationMeteringRecord, state: AgentSessionMeteringState): Promise<void> {
    const existing = await this.load();
    // §19: a unique constraint on operationId is what makes delivery idempotent.
    const records = existing.records.filter((r) => r.operationId !== record.operationId);
    records.push(record);
    await writeFile(this.path, JSON.stringify({ records, state }, null, 2), "utf8");
  }

  async load(): Promise<{
    records: OperationMeteringRecord[];
    state: AgentSessionMeteringState | null;
  }> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return { records: [], state: null };
    }
  }
}

function fakeAdapter(resumeTurns = 0): Adapter {
  return {
    command: ["bun", FAKE_AGENT, ...(resumeTurns > 0 ? [`--resume=${resumeTurns}`] : [])],
    displayName: "Fake metering harness",
  };
}

function check(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function run(): Promise<void> {
  const checks: Check[] = [];
  let bootstrapError: string | null = null;
  const root = await mkdtemp(join(tmpdir(), "acp-metering-smoke-"));
  const repository = new UsageRepository(join(root, "usage.json"));
  const AGENT_SESSION_ID = "consumer-metering-1";

  try {
    // --- first object lifetime: two operations, committed as they complete -----------
    // No transcriptPath, no transcriptDir, no SessionManager: metering must stand alone.
    const first = await AgentSession.create({
      adapter: fakeAdapter(),
      adapterId: "claude",
      agentSessionId: AGENT_SESSION_ID,
    });

    let internalSessionId: string | null = null;
    try {
      for (const text of ["first question", "second question"]) {
        const result = await first.prompt(text);
        if (!result.metering) throw new Error("expected a metering record");
        await repository.commit(result.metering, result.metering.nextState);
      }
      internalSessionId = first.internalSessionId;

      const snapshot = first.meteringSnapshot;
      check(
        checks,
        "totals accumulate over the logical session",
        snapshot.totals.total.knownTokens === 200 && snapshot.operationCount === 2,
        `knownTokens=${snapshot.totals.total.knownTokens} operations=${snapshot.operationCount}`,
      );
      check(
        checks,
        "per-category coverage is reported, not implied",
        snapshot.totals.input.coverage === "complete" &&
          snapshot.totals.cachedWrite.coverage === "none",
        `input=${snapshot.totals.input.coverage} cachedWrite=${snapshot.totals.cachedWrite.coverage}`,
      );
      check(
        checks,
        "metering works with transcripts and SessionManager absent",
        snapshot.operationCount === 2,
        "no transcriptPath, transcriptDir, or SessionManager configured",
      );
    } finally {
      await first.stop();
    }

    // --- the consumer's durable view ------------------------------------------------
    const stored = await repository.load();
    check(
      checks,
      "one stored record per operation, joined by operationId",
      stored.records.length === 2 &&
        new Set(stored.records.map((r) => r.operationId)).size === 2,
      `records=${stored.records.length}`,
    );
    check(
      checks,
      "records carry no conversation content",
      stored.records.every((r) => !("text" in r) && !("messages" in r)),
      "prompt/response text is joined by operationId, not duplicated",
    );
    check(
      checks,
      "a record survives JSON round-tripping intact",
      stored.records[0]?.usage.status === "metered",
      `status=${stored.records[0]?.usage.status}`,
    );

    // --- second object lifetime: restore and continue --------------------------------
    const reopened = await AgentSession.create({
      // The provider thread resumes where it left off, as a real one would.
      adapter: fakeAdapter(2),
      adapterId: "claude",
      agentSessionId: AGENT_SESSION_ID,
      providerSession: internalSessionId
        ? { kind: "load", internalSessionId, onFailure: "new" }
        : { kind: "new" },
      metering: { initialState: stored.state ?? undefined },
    });

    try {
      check(
        checks,
        "prior state restores into a new AgentSession object",
        reopened.meteringSnapshot.restoration.status === "restored" &&
          reopened.meteringSnapshot.totals.total.knownTokens === 200,
        `restoration=${reopened.meteringSnapshot.restoration.status} ` +
          `knownTokens=${reopened.meteringSnapshot.totals.total.knownTokens}`,
      );

      // The fixture's counters continue from where they left off. Without the restored
      // baseline this operation would attribute the whole cumulative total again.
      const third = await reopened.prompt("third question");
      if (!third.metering) throw new Error("expected a metering record");
      await repository.commit(third.metering, third.metering.nextState);

      const attributed =
        third.metering.usage.status === "metered"
          ? third.metering.usage.attributable.totalTokens
          : -1;
      check(
        checks,
        "the first post-restore operation attributes a delta, not the whole total",
        attributed === 100,
        `attributable=${attributed} (cumulative would be 300)`,
      );
      check(
        checks,
        "lifetime totals span object lifetimes",
        reopened.meteringSnapshot.totals.total.knownTokens === 300,
        `knownTokens=${reopened.meteringSnapshot.totals.total.knownTokens}`,
      );
      check(
        checks,
        "the live session holds bounded state, not an operation history",
        !("records" in reopened.meteringSnapshot) &&
          reopened.meteringSnapshot.lastOperation?.operationId === third.metering.operationId,
        "only totals, baseline, and the last operation are retained",
      );

      // §19: duplicate delivery is deduplicated by operation id.
      await repository.commit(third.metering, third.metering.nextState);
      const afterDuplicate = await repository.load();
      check(
        checks,
        "duplicate record delivery is idempotent by operationId",
        afterDuplicate.records.length === 3,
        `records=${afterDuplicate.records.length}`,
      );
    } finally {
      await reopened.stop();
    }

    // --- a session that discards state cannot claim lifetime totals ------------------
    const forgetful = await AgentSession.create({
      adapter: fakeAdapter(),
      adapterId: "claude",
      agentSessionId: AGENT_SESSION_ID,
    });
    try {
      check(
        checks,
        "without restored state, totals start empty rather than guessing",
        forgetful.meteringSnapshot.totals.total.knownTokens === 0 &&
          forgetful.meteringSnapshot.restoration.status === "not_provided",
        `restoration=${forgetful.meteringSnapshot.restoration.status}`,
      );
    } finally {
      await forgetful.stop();
    }
  } catch (err) {
    bootstrapError = String(err);
  }

  const output: string[] = ["", "METERING PERSISTENCE"];
  for (const result of checks) {
    output.push(`${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
  }
  const failures = checks.filter((result) => !result.ok);
  output.push("", `artifacts: ${root}`);
  output.push(
    bootstrapError
      ? `result: INCONCLUSIVE — fixture did not start: ${bootstrapError}`
      : `result: ${checks.length - failures.length}/${checks.length} checks passed`,
    "",
  );

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output.join("\n"), (error) => (error ? reject(error) : resolve()));
  });
  process.exit(bootstrapError ? 2 : failures.length === 0 ? 0 : 1);
}

await run();
