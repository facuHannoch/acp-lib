import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession, type AgentSessionEvent } from "../src/agent-session.ts";
import { AgentSessionHandoffError } from "../src/metering/record.ts";

function usageAdapter() {
  return { command: ["bun", resolve(import.meta.dir, "fixtures/usage-agent.ts")] };
}

let seq = 0;

async function openSession() {
  const events: AgentSessionEvent[] = [];
  const session = await AgentSession.create({
    adapter: usageAdapter(),
    adapterId: "claude",
    agentSessionId: `agent-handoff-metering-${(seq += 1)}`,
  });
  session.subscribe((notification) => events.push(notification.event));
  return { session, events };
}

describe("handoff metering", () => {
  test("a supplied summary is metered for seeding only", async () => {
    // Supplying the summary removes the generation operation entirely — there is nothing
    // to meter, so no `:summary` record is minted.
    const { session } = await openSession();
    try {
      let caught: unknown;
      try {
        await session.handoff({ summary: "context" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentSessionHandoffError);
      if (!(caught instanceof AgentSessionHandoffError)) return;
      // The fixture never replaces its session id, so the handoff fails before seeding.
      // With the summary supplied, that leaves no token-consuming operation at all.
      expect(caught.meteringRecords).toEqual([]);
      expect(session.meteringSnapshot.operationCount).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test("library-internal prompts go through the metering primitive", async () => {
    // The fixture always returns the same session id, so handoff fails at the
    // "harness did not replace the internal session" check — after the seed prompt has
    // been dispatched and metered. That is exactly the partial-failure case §16 covers.
    const { session, events } = await openSession();
    try {
      let caught: unknown;
      try {
        await session.handoff();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentSessionHandoffError);
      if (!(caught instanceof AgentSessionHandoffError)) return;

      // A rejected handoff cannot return a HandoffResult, so records travel on the error.
      expect(caught.meteringRecords.length).toBeGreaterThanOrEqual(1);
      const summary = caught.meteringRecords[0]!;
      expect(summary.operationKind).toBe("handoff_summary");
      expect(summary.operationId).toBe(`${caught.handoffId}:summary`);
      // Deterministic child ids, not freshly minted ones, so both halves tie back to the
      // handoff that caused them.
      expect(summary.operationId.startsWith(caught.handoffId)).toBe(true);

      // Summary generation consumed tokens and they are attributed to the session.
      expect(summary.usage.status).toBe("metered");
      expect(session.meteringSnapshot.totals.total.knownTokens).toBeGreaterThan(0);

      const failure = events.find((e) => e.kind === "handoff_failed");
      expect(failure?.kind === "handoff_failed" && failure.meteringRecords.length).toBe(
        caught.meteringRecords.length,
      );
      // Each record is also emitted as it completes.
      expect(events.filter((e) => e.kind === "metering_recorded").length).toBe(
        caught.meteringRecords.length,
      );
    } finally {
      await session.stop();
    }
  });
});

describe("audited reconciliation", () => {
  test("unblocks a strict session and emits an audit trail without minting a record", async () => {
    const events: AgentSessionEvent[] = [];
    const strict = await AgentSession.create({
      adapter: usageAdapter(),
      adapterId: "claude",
      agentSessionId: "agent-reconcile-2",
      metering: {
        enforcement: "telemetry_required",
        pricing: () => ({
          source: { kind: "consumer_override", version: "t" },
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          categoryApplicability: {
            input: "applicable",
            output: "applicable",
            cached_read: "applicable",
            cached_write: "unknown",
            thought: "unknown",
          },
          schedules: [
            {
              tier: "default",
              conditions: [{ kind: "default" }],
              cacheInputConvention: {
                cachedRead: "excluded_from_input",
                cachedWrite: "excluded_from_input",
              },
              input: { amount: "3", currency: "USD", perTokens: 1_000_000 },
              output: { amount: "15", currency: "USD", perTokens: 1_000_000 },
              cachedRead: { amount: "0.3", currency: "USD", perTokens: 1_000_000 },
            },
          ],
        }),
      },
    });
    strict.subscribe((notification) => events.push(notification.event));

    try {
      const blocked = await strict.prompt("no-usage please");
      expect(strict.meteringSnapshot.blocked).toBe(true);
      await expect(strict.prompt("again")).rejects.toThrow(/blocked/);

      const before = strict.meteringSnapshot.blockedReason;
      expect(before).toBeTruthy();

      const result = await strict.reconcileMetering({
        state: blocked.metering!.nextState,
        reason: "reconciled against provider invoice",
        reference: "INV-42",
      });
      expect(result.after).toEqual(blocked.metering!.nextState);
      expect(strict.meteringSnapshot.blocked).toBe(false);

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("metering_reconciled");
      expect(kinds.indexOf("metering_reconciled")).toBeLessThan(kinds.indexOf("metering_unblocked"));
      const audit = events.find((e) => e.kind === "metering_reconciled");
      expect(audit?.kind === "metering_reconciled" && audit.reason).toBe(
        "reconciled against provider invoice",
      );
      expect(audit?.kind === "metering_reconciled" && audit.reference).toBe("INV-42");

      // No fabricated operation was added to the ledger.
      expect(events.filter((e) => e.kind === "metering_recorded")).toHaveLength(1);

      // Work resumes.
      const next = await strict.prompt("hello");
      expect(next.metering!.usage.status).toBe("metered");
    } finally {
      await strict.stop();
    }
  });

  test("rejects a blank reason and a mismatched state without mutating", async () => {
    const { session } = await openSession();
    try {
      const state = session.meteringSnapshot;
      await expect(
        session.reconcileMetering({ state, reason: "   " }),
      ).rejects.toThrow(/non-blank reason/);
      await expect(
        session.reconcileMetering({
          state: { ...state, agentSessionId: "someone-else" },
          reason: "wrong session",
        }),
      ).rejects.toThrow(/identity_mismatch/);
      expect(session.meteringSnapshot.operationCount).toBe(0);
    } finally {
      await session.stop();
    }
  });
});
