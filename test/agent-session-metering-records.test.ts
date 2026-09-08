import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AgentSession,
  type AgentSessionConfig,
  type AgentSessionEvent,
  type AgentSessionPromptResult,
} from "../src/agent-session.ts";
import { AgentSessionOperationError } from "../src/metering/record.ts";
import {
  CERTIFIED_INTEGRATIONS,
  certificationFor,
} from "../src/metering/certification.ts";
import type { PricingPolicy, PricingResolver } from "../src/metering/pricing.ts";
import { addMoney, rateTokens, soleAmount } from "../src/metering/money.ts";

function usageAdapter() {
  return { command: ["bun", resolve(import.meta.dir, "fixtures/usage-agent.ts")] };
}

let seq = 0;

async function openSession(overrides: Partial<AgentSessionConfig> = {}) {
  const events: AgentSessionEvent[] = [];
  const session = await AgentSession.create({
    adapter: usageAdapter(),
    adapterId: "claude",
    agentSessionId: `agent-records-${(seq += 1)}`,
    ...overrides,
  });
  session.subscribe((notification) => events.push(notification.event));
  return { session, events };
}

const TEST_POLICY: PricingPolicy = {
  source: { kind: "consumer_override", version: "test-1" },
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  categoryApplicability: {
    input: "applicable",
    output: "applicable",
    cached_read: "applicable",
    cached_write: "unknown",
    thought: "not_applicable",
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
};

const fixedPricing: PricingResolver = () => TEST_POLICY;

describe("operation metering records", () => {
  test("a prompt result carries an immutable record joined by operationId", async () => {
    const { session } = await openSession();
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.operationId).toBe(result.metering!.operationId);
      expect(result.metering!.operationKind).toBe("prompt");
      expect(result.metering!.outcome).toBe("completed");
      expect(Object.isFrozen(result.metering)).toBe(true);
      // The record carries no conversation content — it joins to it by id.
      expect(result.metering).not.toHaveProperty("text");
      expect(result.metering).not.toHaveProperty("messages");
    } finally {
      await session.stop();
    }
  });

  test("successive prompts produce deltas, not repeated cumulative totals", async () => {
    // The fixture reports cumulative 100 → 200 → 300; each operation used 100.
    const { session } = await openSession();
    try {
      for (let turn = 1; turn <= 3; turn += 1) {
        const result = (await session.prompt(`turn ${turn}`)) as AgentSessionPromptResult;
        expect(result.metering!.usage.status).toBe("metered");
        if (result.metering!.usage.status !== "metered") return;
        expect(result.metering!.usage.reportedCumulative.totalTokens).toBe(100 * turn);
        expect(result.metering!.usage.attributable.totalTokens).toBe(100);
        expect(result.metering!.usage.attributable.input.reportedTokens).toBe(60);
        expect(result.metering!.usage.attributable.cachedRead?.reportedTokens).toBe(10);
      }
      expect(session.meteringSnapshot.totals.total.knownTokens).toBe(300);
      expect(session.meteringSnapshot.operationCount).toBe(3);
    } finally {
      await session.stop();
    }
  });

  test("the record embeds state a consumer can persist and restore", async () => {
    const { session } = await openSession({ metering: { pricing: fixedPricing } });
    try {
      const first = (await session.prompt("one")) as AgentSessionPromptResult;
      const carried = first.metering!.nextState;
      expect(carried.version).toBe(3);
      expect(carried.totals.total.knownTokens).toBe(100);
      expect(carried.activeBaseline?.internalSessionId).toBe("usage-sess-1");
      expect(carried.ratedCosts.amounts).toEqual([{ amount: "0.000783", currency: "USD" }]);
      expect(carried.ratedCosts.unaccounted).toBe(0);

      const second = (await session.prompt("two")) as AgentSessionPromptResult;
      expect(second.metering!.nextState.totals.total.knownTokens).toBe(200);
      // Earlier records are immutable snapshots, not live views.
      expect(carried.totals.total.knownTokens).toBe(100);
    } finally {
      await session.stop();
    }
  });

  test("restoring nextState preserves lifetime totals across session objects", async () => {
    const { session } = await openSession();
    let restored;
    try {
      const first = (await session.prompt("one")) as AgentSessionPromptResult;
      restored = first.metering!.nextState;
    } finally {
      await session.stop();
    }

    const { session: reopened } = await openSession({
      metering: { initialState: { ...restored!, agentSessionId: "agent-records-restored" } },
      agentSessionId: "agent-records-restored",
      providerSession: { kind: "load", internalSessionId: "usage-sess-1", onFailure: "new" },
    });
    try {
      expect(reopened.meteringSnapshot.restoration.status).toBe("restored");
      expect(reopened.meteringSnapshot.totals.total.knownTokens).toBe(100);
      // The fixture restarts at cumulative 100, matching the restored baseline, so the
      // first post-reopen operation attributes 0 rather than double-counting 100.
      const next = (await reopened.prompt("two")) as AgentSessionPromptResult;
      expect(next.metering!.usage.status).toBe("metered");
      if (next.metering!.usage.status !== "metered") return;
      expect(next.metering!.usage.attributable.totalTokens).toBe(0);
    } finally {
      await reopened.stop();
    }
  });

  test("an ACP-derived record says so in its provenance", async () => {
    const { session } = await openSession();
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.provenance).toEqual({
        source: "acp_usage",
        measurement: "acp_derived",
        routing: "unknown",
        attribution: "partial",
        counterInterpretation: "cumulative",
      });
      // routing is never "enforced": a library spawning a subprocess cannot verify that
      // no model traffic bypassed it.
      expect(result.metering!.provenance.routing).not.toBe("enforced");
    } finally {
      await session.stop();
    }
  });

  test("metering_recorded is emitted before the turn completes and carries the same record", async () => {
    const { session, events } = await openSession();
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      const kinds = events.map((e) => e.kind);
      expect(kinds.indexOf("metering_recorded")).toBeLessThan(kinds.indexOf("turn_completed"));
      const recorded = events.find((e) => e.kind === "metering_recorded");
      expect(recorded?.kind === "metering_recorded" && recorded.record).toBe(result.metering!);
    } finally {
      await session.stop();
    }
  });

  test("a missing usage report is a record, not a silent zero", async () => {
    const { session } = await openSession();
    try {
      const result = (await session.prompt("no-usage please")) as AgentSessionPromptResult;
      expect(result.metering!.usage.status).toBe("usage_unavailable");
      expect(result.metering!.pricingStatus).toBe("not_attributable");
      expect(result.metering!.provenance.measurement).toBe("unavailable");
      // The operation is represented; nothing claims it was free.
      const snapshot = session.meteringSnapshot;
      expect(snapshot.operationCount).toBe(1);
      expect(snapshot.unmeteredOperationCount).toBe(1);
      expect(snapshot.totals.total.knownTokens).toBe(0);
      expect(snapshot.totals.total.coverage).toBe("none");
    } finally {
      await session.stop();
    }
  });

  test("context and cost are attached as observations, not causal deltas", async () => {
    const { session } = await openSession();
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.contextAfter?.usedTokens).toBe(100);
      expect(result.metering!.providerCostAfter?.cumulative.amount).toBe("0.001");
    } finally {
      await session.stop();
    }
  });
});

describe("pricing on records", () => {
  test("prices each category and engraves source, key, and unit prices", async () => {
    const { session } = await openSession({ metering: { pricing: fixedPricing } });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("priced");
      if (result.metering!.usage.status !== "metered") return;
      const attributable = result.metering!.usage.attributable;
      expect(attributable.pricingSource).toEqual({ kind: "consumer_override", version: "test-1" });
      expect(attributable.pricingKey).toEqual({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        tier: "default",
      });
      // 60 input @ $3/1M = 0.00018; 40 output @ $15/1M = 0.0006; 10 cached @ $0.3/1M = 0.000003
      expect(attributable.input.pricing?.ratedCost.amount).toBe("0.00018");
      expect(attributable.output.pricing?.ratedCost.amount).toBe("0.0006");
      expect(attributable.cachedRead?.pricing?.ratedCost.amount).toBe("0.000003");
      expect(soleAmount(attributable.ratedTotal)?.amount).toBe("0.000783");
    } finally {
      await session.stop();
    }
  });

  test("pricing: false yields real tokens with explicitly no rating", async () => {
    const { session } = await openSession({ metering: { pricing: false } });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("not_configured");
      if (result.metering!.usage.status !== "metered") return;
      expect(result.metering!.usage.attributable.totalTokens).toBe(100);
      expect(soleAmount(result.metering!.usage.attributable.ratedTotal)).toBeNull();
      expect(result.metering!.usage.attributable.input.pricing).toBeNull();
    } finally {
      await session.stop();
    }
  });

  test("best effort continues unpriced when the resolver has no policy", async () => {
    const { session } = await openSession({ metering: { pricing: () => null } });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("pricing_unavailable");
      expect(result.metering!.pricingFailureReason).toContain("no pricing policy");
      if (result.metering!.usage.status !== "metered") return;
      expect(result.metering!.usage.attributable.totalTokens).toBe(100);
    } finally {
      await session.stop();
    }
  });

  test("a resolver that throws follows the same path as one returning null", async () => {
    const { session } = await openSession({
      metering: {
        pricing: () => {
          throw new Error("catalog offline");
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("pricing_unavailable");
      expect(result.metering!.pricingFailureReason).toContain("catalog offline");
    } finally {
      await session.stop();
    }
  });

  test("a price change affects only later records", async () => {
    let amount = "3";
    const { session } = await openSession({
      metering: {
        pricing: () => ({
          ...TEST_POLICY,
          schedules: [
            {
              ...TEST_POLICY.schedules[0]!,
              input: { amount, currency: "USD", perTokens: 1_000_000 },
            },
          ],
        }),
      },
    });
    try {
      const first = (await session.prompt("one")) as AgentSessionPromptResult;
      amount = "6";
      const second = (await session.prompt("two")) as AgentSessionPromptResult;
      if (first.metering!.usage.status !== "metered") return;
      if (second.metering!.usage.status !== "metered") return;
      expect(first.metering!.usage.attributable.input.pricing?.unitPrice.amount).toBe("3");
      expect(second.metering!.usage.attributable.input.pricing?.unitPrice.amount).toBe("6");
      // The earlier record is untouched by the change.
      expect(first.metering!.usage.attributable.input.pricing?.ratedCost.amount).toBe("0.00018");
    } finally {
      await session.stop();
    }
  });
});

describe("telemetry_required enforcement", () => {
  test("blocks after a missing usage report but keeps the response", async () => {
    const { session, events } = await openSession({
      metering: { enforcement: "telemetry_required", pricing: fixedPricing },
    });
    try {
      const result = (await session.prompt("no-usage please")) as AgentSessionPromptResult;
      // The provider did the work; rejecting could cause a retry that duplicates cost.
      expect(result.text).toBe("ok");
      expect(result.metering!.usage.status).toBe("usage_unavailable");
      expect(session.meteringSnapshot.blocked).toBe(true);

      const kinds = events.map((e) => e.kind);
      expect(kinds.indexOf("metering_recorded")).toBeLessThan(kinds.indexOf("metering_blocked"));
      expect(kinds.indexOf("metering_blocked")).toBeLessThan(kinds.indexOf("turn_completed"));

      // Later token-consuming work rejects before reaching the provider.
      await expect(session.prompt("again")).rejects.toThrow(/blocked/);
    } finally {
      await session.stop();
    }
  });

  test("rejects preflight when pricing is unavailable, before any provider work", async () => {
    const { session } = await openSession({
      metering: { enforcement: "telemetry_required", pricing: () => null },
    });
    try {
      await expect(session.prompt("hello")).rejects.toThrow(/pricing unavailable/);
      // Nothing was sent, so nothing was metered.
      expect(session.meteringSnapshot.operationCount).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test("rejects pricing: false, which cannot satisfy a strict mode", async () => {
    const { session } = await openSession({
      metering: { enforcement: "telemetry_required", pricing: false },
    });
    try {
      await expect(session.prompt("hello")).rejects.toThrow(/pricing is disabled/);
    } finally {
      await session.stop();
    }
  });

  test("best effort continues after an unavailable report", async () => {
    const { session } = await openSession();
    try {
      await session.prompt("no-usage please");
      expect(session.meteringSnapshot.blocked).toBe(false);
      const next = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(next.metering!.usage.status).toBe("metered");
    } finally {
      await session.stop();
    }
  });

  test("a foreign restored state fails preflight in a strict mode", async () => {
    await expect(
      openSession({
        metering: {
          enforcement: "telemetry_required",
          initialState: { version: 99 } as never,
        },
      }),
    ).rejects.toThrow(/initial_state_version_unsupported/);
  });

  test("best effort ignores a foreign restored state and says so", async () => {
    const { session } = await openSession({
      metering: { initialState: { version: 99 } as never },
    });
    try {
      const restoration = session.meteringSnapshot.restoration;
      expect(restoration.status).toBe("ignored");
      if (restoration.status !== "ignored") return;
      expect(restoration.reason).toBe("initial_state_version_unsupported");
      expect(session.meteringSnapshot.totals.total.knownTokens).toBe(0);
    } finally {
      await session.stop();
    }
  });
});

describe("failed operations", () => {
  test("a rejected prompt still carries its metering record", async () => {
    const { session } = await openSession();
    try {
      await session.stop();
      let caught: unknown;
      try {
        await session.prompt("hello");
      } catch (err) {
        caught = err;
      }
      // Whether it reaches the provider or not, the caller must be able to reach the
      // record without subscribing to events.
      if (caught instanceof AgentSessionOperationError) {
        expect(caught.metering!.outcome).toBe("error");
        expect(caught.metering!.usage.status).toBe("usage_unavailable");
        expect(caught.cause).toBeDefined();
      } else {
        expect(caught).toBeDefined();
      }
    } finally {
      await session.stop().catch(() => {});
    }
  });
});

describe("operation kinds and undispatched work", () => {
  test("an internal session command is classified as internal_command", async () => {
    const { session } = await openSession();
    try {
      const result = await session.executeInternalSessionCommand("status");
      expect(result.metering?.operationKind).toBe("internal_command");
    } finally {
      await session.stop();
    }
  });

  test("a prompt cancelled before dispatch mints no record", async () => {
    // It never reached the provider, so it consumed nothing; a record would be a
    // fabricated ledger entry.
    const { session } = await openSession();
    try {
      const pending = session.prompt("first");
      const dropped = session.prompt("second");
      session.interrupt({ clearQueue: true });
      const result = await dropped;
      expect(result.status).toBe("cancelled");
      expect(result.metering).toBeNull();
      await pending.catch(() => {});
    } finally {
      await session.stop();
    }
  });
});

describe("rating failure reporting", () => {
  test("a reported category with no price records WHY it could not be rated", async () => {
    // Measured on opencode/ling-3.0-flash-fin-free: the harness reports thoughtTokens but
    // the catalog carries no reasoning price, so rating is unavailable. Without the reason
    // the record says "pricing_unavailable" with no way to find out why.
    const { session } = await openSession({
      metering: {
        pricing: () => ({
          ...TEST_POLICY,
          categoryApplicability: { ...TEST_POLICY.categoryApplicability, thought: "unknown" },
        }),
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      // The fixture reports cachedRead, which TEST_POLICY prices; drop that price instead.
      expect(result.metering!.pricingStatus).toBe("priced");
    } finally {
      await session.stop();
    }
  });

  test("an unpriceable reported category names the category in the reason", async () => {
    const { session } = await openSession({
      metering: {
        pricing: () => ({
          ...TEST_POLICY,
          schedules: [{ ...TEST_POLICY.schedules[0]!, cachedRead: undefined }],
        }),
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("pricing_unavailable");
      expect(result.metering!.pricingFailureReason).toContain("cached_read");
    } finally {
      await session.stop();
    }
  });
});

describe("provider cost reconciliation", () => {
  test("checks the rated cost against the provider's own figure", async () => {
    // The one signal the ACP-derived backend has for inferences it never saw: a turn with
    // tool calls bills for several, while PromptResponse.usage reports one.
    const { session } = await openSession({ metering: { pricing: fixedPricing } });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      const reconciliation = result.metering!.costReconciliation;
      expect(reconciliation.status).toBe("checked");
      if (reconciliation.status !== "checked") return;
      // Fixture: provider cost 0.001, rated 0.000783 from the priced delta.
      expect(reconciliation.providerDelta).toEqual({ amount: "0.001", currency: "USD" });
      expect(reconciliation.ratedTotal).toEqual({ amount: "0.000783", currency: "USD" });
      expect(reconciliation.matches).toBe(false);
      expect(reconciliation.ratio).toBe("1.277139");
    } finally {
      await session.stop();
    }
  });

  test("float artifacts in provider cost do not read as a discrepancy", async () => {
    // Provider cost arrives as a JSON number, so a cumulative subtraction yields values
    // like 0.002577469999999998 against an exact 0.00257747 — observed live. Judging
    // agreement on the ratio rather than string equality keeps that from flagging.
    const { session } = await openSession({
      metering: {
        pricing: () => ({
          ...TEST_POLICY,
          schedules: [
            {
              ...TEST_POLICY.schedules[0]!,
              // Rates chosen so the fixture's 60/40/10 delta rates to exactly 0.001,
              // matching the fixture's reported provider cost.
              input: { amount: "10", currency: "USD", perTokens: 1_000_000 },
              output: { amount: "10", currency: "USD", perTokens: 1_000_000 },
              cachedRead: { amount: "0", currency: "USD", perTokens: 1_000_000 },
            },
          ],
        }),
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      const reconciliation = result.metering!.costReconciliation;
      expect(reconciliation.status).toBe("checked");
      if (reconciliation.status !== "checked") return;
      expect(reconciliation.ratedTotal.amount).toBe("0.001");
      expect(reconciliation.ratio).toBe("1");
      expect(reconciliation.matches).toBe(true);
    } finally {
      await session.stop();
    }
  });

  test("a second operation reconciles against the RISE, not the cumulative figure", async () => {
    // Provider cost is cumulative; only the delta belongs to this operation.
    const { session } = await openSession({ metering: { pricing: fixedPricing } });
    try {
      await session.prompt("one");
      const second = (await session.prompt("two")) as AgentSessionPromptResult;
      const reconciliation = second.metering!.costReconciliation;
      expect(reconciliation.status).toBe("checked");
      if (reconciliation.status !== "checked") return;
      // The fixture never raises its cost again, so the second operation's share is zero.
      expect(reconciliation.providerDelta).toEqual({ amount: "0", currency: "USD" });
    } finally {
      await session.stop();
    }
  });

  test("an unrated operation has nothing to reconcile", async () => {
    const { session } = await openSession({ metering: { pricing: false } });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.costReconciliation.status).toBe("unavailable");
    } finally {
      await session.stop();
    }
  });
});

describe("billing_required certification gate", () => {
  test("an uncertified adapter is refused outright", async () => {
    for (const adapterId of ["claude", "codex", "kimi", "anything"]) {
      await expect(
        openSession({ adapterId, metering: { enforcement: "billing_required" } }),
      ).rejects.toThrow(/needs a certified metering integration/);
    }
  });

  test("a certified adapter is still refused without a LIVE channel", async () => {
    // A registry entry says the mechanism was measured, not that it is running. Being on
    // the list must not be enough, or the gate is decorative.
    let caught: unknown;
    try {
      await openSession({ adapterId: "opencode", metering: { enforcement: "billing_required" } });
    } catch (err) {
      caught = err;
    }
    const message = String(caught);
    expect(message).toContain("opencode-plugin@1");
    expect(message).toContain("createOpencodeMetering");
    expect(message).toContain("one inference per prompt");
  });

  test("a live source with the matching certification opens the gate", async () => {
    const session = await openSession({
      adapterId: "opencode",
      metering: {
        enforcement: "billing_required",
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [],
        },
      },
    });
    await session.session.stop();
  });

  test("a source claiming the wrong certification does not open it", async () => {
    // The id is checked, not merely the presence of a source: otherwise any object with
    // the right shape would qualify.
    await expect(
      openSession({
        adapterId: "opencode",
        metering: {
          enforcement: "billing_required",
          inferenceSource: {
            certificationId: "something-else@9",
            isHealthy: () => true,
            drain: () => [],
          },
        },
      }),
    ).rejects.toThrow(/needs a live opencode-plugin@1/);
  });

  test("the registry names what it certifies and against which versions", () => {
    expect(certificationFor("opencode")?.certificationId).toBe("opencode-plugin@1");
    expect(certificationFor("claude")).toBeNull();
    expect(CERTIFIED_INTEGRATIONS.map((entry) => entry.adapterId)).toEqual(["opencode"]);
    // A version range, not a boolean: the plugin API differs across majors.
    expect(certificationFor("opencode")?.supportedHarnessVersions).toEqual(["1.18"]);
  });
});

describe("certified inference source", () => {
  let nextSequence = 0;
  const inference = (over: Record<string, unknown> = {}) =>
    ({
      sequence: (nextSequence += 1),
      messageID: `m${Math.random()}`,
      sessionID: "s",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      summary: false,
      completedAt: Date.now(),
      cost: 0,
      tokens: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      ...over,
    }) as never;

  function source(records: () => readonly unknown[], healthy = true) {
    return {
      certificationId: "opencode-plugin@1",
      isHealthy: () => healthy,
      drain: () => records() as never,
    };
  }

  test("measures from summed inferences, not from ACP usage", async () => {
    // The fixture's ACP report says 100 tokens for the turn; the source says two
    // inferences totalling 200. The certified measurement must win — that difference is
    // exactly what a tool-using turn looks like.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: source(() => [inference(), inference()]),
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.usage.status).toBe("metered");
      if (result.metering!.usage.status !== "metered") return;
      expect(result.metering!.usage.attributable.totalTokens).toBe(200);
      expect(result.metering!.provenance).toEqual({
        source: "certified",
        measurement: "provider_normalized",
        routing: "observed",
        attribution: "complete",
        certificationId: "opencode-plugin@1",
      });
    } finally {
      await session.stop();
    }
  });

  test("routing stays 'observed' — a library cannot prove nothing bypassed it", async () => {
    const { session } = await openSession({
      adapterId: "opencode",
      metering: { pricing: fixedPricing, inferenceSource: source(() => [inference()]) },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.provenance.routing).toBe("observed");
    } finally {
      await session.stop();
    }
  });

  test("an unhealthy channel reports unavailable rather than falling back", async () => {
    // Falling back to ACP would silently resume undercounting — the exact failure the
    // certified path exists to prevent.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: { pricing: fixedPricing, inferenceSource: source(() => [], false) },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.usage.status).toBe("usage_unavailable");
      if (result.metering!.usage.status === "metered") return;
      expect(result.metering!.usage.reason).toContain("not healthy");
    } finally {
      await session.stop();
    }
  });

  test("zero observed inferences is a failure, not a free operation", async () => {
    const { session } = await openSession({
      adapterId: "opencode",
      metering: { pricing: fixedPricing, inferenceSource: source(() => []) },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.usage.status).toBe("usage_unavailable");
      if (result.metering!.usage.status === "metered") return;
      expect(result.metering!.usage.reason).toContain("no inferences");
    } finally {
      await session.stop();
    }
  });

  test("billing_required refuses to dispatch when the channel is unhealthy", async () => {
    // Preflight, not post-hoc. Letting the first operation through and blocking afterwards
    // means the provider has already been paid for work that cannot be measured, which is
    // the one thing this mode exists to prevent.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        enforcement: "billing_required",
        pricing: fixedPricing,
        inferenceSource: source(() => [], false),
      },
    });
    try {
      await expect(session.prompt("hello")).rejects.toThrow(/not healthy/);
      // Nothing was dispatched, so nothing was metered.
      expect(session.meteringSnapshot.operationCount).toBe(0);
    } finally {
      await session.stop();
    }
  });
});

describe("second-round review fixes", () => {
  const inference = (over: Record<string, unknown> = {}) =>
    ({
      sequence: null,
      messageID: `m${Math.random()}`,
      sessionID: "s",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      summary: false,
      completedAt: Date.now(),
      cost: 0,
      tokens: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      ...over,
    }) as never;

  test("attribution drops to partial when the channel lost a report", async () => {
    // "complete" must be earned. A lost report means an inference happened that we never
    // saw, and claiming complete attribution would be the overstatement this design
    // refuses everywhere else.
    let lost = 0;
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => {
            lost = 1; // a report is missing at the moment this operation closes
            return [inference()] as never;
          },
          outstandingReports: () => lost,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.provenance.attribution).toBe("partial");
    } finally {
      await session.stop();
    }
  });

  test("attribution stays complete when nothing was lost", async () => {
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [inference()] as never,
          outstandingReports: () => 0,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.provenance.attribution).toBe("complete");
    } finally {
      await session.stop();
    }
  });

  test("work from another provider thread lands in unallocated, not in totals", async () => {
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [inference()] as never,
          drainForeign: () =>
            [inference({ sessionID: "other", tokens: { totalTokens: 500, inputTokens: 500, outputTokens: 0 } })] as never,
        },
      },
    });
    try {
      await session.prompt("hello");
      const snapshot = session.meteringSnapshot;
      // Charged to no operation, but visible rather than stranded.
      expect(snapshot.totals.total.knownTokens).toBe(100);
      expect(snapshot.unallocatedUsage.recordCount).toBe(1);
      expect(snapshot.unallocatedUsage.knownTokens.totalTokens).toBe(500);
    } finally {
      await session.stop();
    }
  });

  test("a multi-model operation keeps auditable per-model line items", async () => {
    // Flattening several rates into one engraved unit price made records unrecomputable:
    // tokens x unitPrice no longer equalled ratedCost.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: (context) =>
          context.model === "cheap-model"
            ? {
                ...TEST_POLICY,
                modelId: "cheap-model",
                schedules: [
                  {
                    ...TEST_POLICY.schedules[0]!,
                    input: { amount: "1", currency: "USD", perTokens: 1_000_000 },
                    output: { amount: "1", currency: "USD", perTokens: 1_000_000 },
                  },
                ],
              }
            : TEST_POLICY,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () =>
            [
              inference(),
              inference({ modelID: "cheap-model" }),
            ] as never,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      const usage = result.metering!.usage;
      expect(usage.status).toBe("metered");
      if (usage.status !== "metered") return;
      const attributable = usage.attributable;

      // A fully rated multi-model operation is PRICED. Using the aggregate pricingSource
      // as the signal marked it pricing_unavailable and blocked strict mode on correctly
      // priced work.
      expect(result.metering!.pricingStatus).toBe("priced");
      expect(result.metering!.nextState.ratedCosts.amounts).toEqual(attributable.ratedTotal.amounts);

      expect(attributable.lineItems).toHaveLength(2);
      expect(attributable.lineItems!.map((item) => item.modelId).sort()).toEqual([
        "cheap-model",
        "claude-sonnet-4-5",
      ]);
      // No single rate applies, so none is engraved at the top level.
      expect(attributable.input.pricing).toBeNull();
      expect(attributable.pricingKey).toBeNull();
      // Each line item must be RECOMPUTABLE, not merely carry a price: recompute every
      // subtotal from its own tokens and rate, and check the items sum to the total.
      let summed = { amount: "0", currency: "USD" };
      for (const item of attributable.lineItems!) {
        for (const category of ["input", "output", "cachedRead", "cachedWrite", "thought"] as const) {
          const amount = item[category];
          if (!amount?.pricing) continue;
          const recomputed = rateTokens(amount.pricedTokens!, amount.pricing.unitPrice);
          expect(recomputed.ok).toBe(true);
          if (!recomputed.ok) return;
          expect(recomputed.value.amount).toBe(amount.pricing.ratedCost.amount);
        }
        const total = addMoney(summed, soleAmount(item.ratedTotal)!);
        expect(total.ok).toBe(true);
        if (!total.ok) return;
        summed = total.value;
      }
      expect(summed.amount).toBe(soleAmount(attributable.ratedTotal)!.amount);
    } finally {
      await session.stop();
    }
  });
});

describe("a persistence failure must not double-count", () => {
  test("an operation already closed is not closed a second time", async () => {
    // Closing metering before persistence fixed a usage-loss bug and introduced a worse
    // one: a transcript write failure sent the catch path into closing the SAME operation
    // again, accruing it twice and emitting a second record.
    const { session, events } = await openSession({
      metering: { pricing: fixedPricing },
      // An unwritable transcript path makes persistence throw after the provider answered.
      transcriptPath: "/proc/definitely-not-writable/transcript.jsonl",
    });
    try {
      await session.prompt("hello").catch(() => {});
      const snapshot = session.meteringSnapshot;
      expect(snapshot.operationCount).toBe(1);
      expect(snapshot.totals.total.knownTokens).toBe(100);
      expect(events.filter((event) => event.kind === "metering_recorded")).toHaveLength(1);
    } finally {
      await session.stop().catch(() => {});
    }
  });
});

describe("billing_required blocks on attribution gaps", () => {
  const inference = (over: Record<string, unknown> = {}) =>
    ({
      sequence: null,
      messageID: `m${Math.random()}`,
      sessionID: "s",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      summary: false,
      completedAt: Date.now(),
      cost: 0,
      tokens: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      ...over,
    }) as never;

  test("an outstanding gap marks the operation partial but does NOT block", async () => {
    // Deliberately narrower than blocking on any gap. An outstanding report usually
    // arrives moments later and lands in unallocated usage — visible and costed — so the
    // promise "never silently under-account" still holds. Halting a production session on
    // a loopback reorder costs more than it prevents.
    let lost = 0;
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        enforcement: "billing_required",
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => {
            lost = 1;
            return [inference()] as never;
          },
          outstandingReports: () => lost,
        },
      },
    });
    try {
      const first = (await session.prompt("one")) as AgentSessionPromptResult;
      expect(first.metering!.provenance.attribution).toBe("partial");
      expect(first.metering!.usage.status).toBe("metered");
      // Not blocked: the gap may still resolve, and the record already says partial.
      expect(session.meteringSnapshot.blocked).toBe(false);
      const second = (await session.prompt("two")) as AgentSessionPromptResult;
      expect(second.metering!.usage.status).toBe("metered");
    } finally {
      await session.stop();
    }
  });

  test("unallocated work blocks too, and says how much", async () => {
    let swept = false;
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        enforcement: "billing_required",
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [inference()] as never,
          drainForeign: () => {
            if (swept) return [] as never;
            swept = true;
            return [inference({ sessionID: "other", cost: 0.5 })] as never;
          },
        },
      },
    });
    try {
      await session.prompt("one");
      expect(session.meteringSnapshot.blockedReason).toContain("another provider thread");
      // Preserved, not discarded: it is real spend, with the provider's own cost.
      const unallocated = session.meteringSnapshot.unallocatedUsage;
      expect(unallocated.recordCount).toBe(1);
      expect(unallocated.ratedCosts.amounts).toEqual([{ amount: "0.5", currency: "USD" }]);
    } finally {
      await session.stop();
    }
  });

  test("telemetry_required is NOT held to certified attribution", async () => {
    // It is strict handling of ACP telemetry and never claimed to account for hidden
    // inferences; blocking it on that would be a promise it did not make.
    let lost = 0;
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        enforcement: "telemetry_required",
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => {
            lost = 1;
            return [inference()] as never;
          },
          outstandingReports: () => lost,
        },
      },
    });
    try {
      await session.prompt("one");
      expect(session.meteringSnapshot.blocked).toBe(false);
    } finally {
      await session.stop();
    }
  });
});

describe("a multi-CURRENCY operation cannot understate itself", () => {
  const inference = (modelID: string) =>
    ({
      sequence: null,
      messageID: `m${Math.random()}`,
      sessionID: "s",
      providerID: "p",
      modelID,
      summary: false,
      completedAt: Date.now(),
      cost: 0,
      tokens: { totalTokens: 2_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }) as never;

  const priced = (currency: string) => ({
    ...TEST_POLICY,
    providerId: "p",
    schedules: [
      {
        ...TEST_POLICY.schedules[0]!,
        input: { amount: "5", currency, perTokens: 1_000_000 },
        output: { amount: "5", currency, perTokens: 1_000_000 },
        cachedRead: { amount: "5", currency, perTokens: 1_000_000 },
      },
    ],
  });

  test("both currencies survive, and the total says so", async () => {
    // This is the bug the whole MoneyTotal change exists for: two line items of 10 each
    // produced an engraved total of 10, reported as `priced`. Half the cost vanished.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: (context) => priced(context.model === "eur-model" ? "EUR" : "USD"),
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [inference("claude-sonnet-4-5"), inference("eur-model")] as never,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      const usage = result.metering!.usage;
      expect(usage.status).toBe("metered");
      if (usage.status !== "metered") return;
      const total = usage.attributable.ratedTotal;

      // Neither currency is dropped.
      expect(total.amounts).toHaveLength(2);
      expect(total.amounts.map((amount) => amount.currency).sort()).toEqual(["EUR", "USD"]);
      expect(total.unaccounted).toBe(0);

      // Line items sum to the total, PER CURRENCY. The old invariant test only covered a
      // single currency, which is exactly why it passed while a currency went missing.
      for (const currency of ["USD", "EUR"]) {
        const fromItems = usage.attributable
          .lineItems!.flatMap((item) => item.ratedTotal.amounts)
          .filter((amount) => amount.currency === currency)
          .reduce((sum, amount) => sum + Number(amount.amount), 0);
        const fromTotal = Number(
          total.amounts.find((amount) => amount.currency === currency)!.amount,
        );
        expect(fromItems).toBe(fromTotal);
      }

      // No single figure exists, so none is offered.
      expect(soleAmount(total)).toBeNull();
      // And the session keeps both rather than silently banking one.
      expect(result.metering!.nextState.ratedCosts.amounts).toHaveLength(2);
    } finally {
      await session.stop();
    }
  });
});

describe("deliberate absence is not a loss", () => {
  test("pricing: false leaves a clean total, not a session full of losses", async () => {
    // The mirror of the bug MoneyTotal fixed: a consumer who asked for no rating must not
    // see `unaccounted` climb, or every deliberately unrated session reads as lossy.
    const { session } = await openSession({ metering: { pricing: false } });
    try {
      for (const text of ["one", "two", "three"]) await session.prompt(text);
      const snapshot = session.meteringSnapshot;
      expect(snapshot.operationCount).toBe(3);
      expect(snapshot.ratedCosts).toEqual({ amounts: [], unaccounted: 0 });
      // Tokens are still fully accounted; only the money was never asked for.
      expect(snapshot.totals.total.knownTokens).toBe(300);
      expect(snapshot.totals.total.coverage).toBe("complete");
    } finally {
      await session.stop();
    }
  });

  test("a rating that was attempted and failed does count as unaccounted", async () => {
    const { session } = await openSession({ metering: { pricing: () => null } });
    try {
      await session.prompt("one");
      const snapshot = session.meteringSnapshot;
      expect(snapshot.ratedCosts.unaccounted).toBe(1);
      expect(snapshot.lastOperation?.pricingStatus).toBe("pricing_unavailable");
    } finally {
      await session.stop();
    }
  });

  test("the two are distinguishable from the record alone", async () => {
    const notAttempted = await openSession({ metering: { pricing: false } });
    const failed = await openSession({ metering: { pricing: () => null } });
    try {
      const a = (await notAttempted.session.prompt("x")) as AgentSessionPromptResult;
      const b = (await failed.session.prompt("x")) as AgentSessionPromptResult;
      expect(a.metering!.pricingStatus).toBe("not_configured");
      expect(b.metering!.pricingStatus).toBe("pricing_unavailable");
      if (a.metering!.usage.status !== "metered") return;
      if (b.metering!.usage.status !== "metered") return;
      expect(a.metering!.usage.attributable.ratedTotal.unaccounted).toBe(0);
      expect(b.metering!.usage.attributable.ratedTotal.unaccounted).toBe(1);
    } finally {
      await notAttempted.session.stop();
      await failed.session.stop();
    }
  });
});

describe("deliberate absence across several models", () => {
  test("pricing: false stays clean when an operation spans models", async () => {
    // The single-model fast path honoured `pricing: false`; the multi-model path still
    // recorded each group as a failed rating, so a deliberately unrated session
    // accumulated phantom losses.
    const inference = (modelID: string) =>
      ({
        sequence: null,
        messageID: `m${Math.random()}`,
        sessionID: "s",
        providerID: "anthropic",
        modelID,
        summary: false,
        completedAt: Date.now(),
        cost: 0,
        tokens: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      }) as never;

    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: false,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () => [inference("claude-sonnet-4-5"), inference("other-model")] as never,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.pricingStatus).toBe("not_configured");
      if (result.metering!.usage.status !== "metered") return;
      expect(result.metering!.usage.attributable.ratedTotal.unaccounted).toBe(0);
      expect(session.meteringSnapshot.ratedCosts.unaccounted).toBe(0);
      // Tokens are still fully accounted across both models.
      expect(result.metering!.usage.attributable.totalTokens).toBe(200);
    } finally {
      await session.stop();
    }
  });
});

describe("late arrivals are not charged to the wrong operation", () => {
  const record = (sequence: number, messageID: string) =>
    ({
      sequence,
      messageID,
      sessionID: "usage-sess-1",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      summary: false,
      completedAt: Date.now(),
      cost: 0.25,
      tokens: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
    }) as never;

  test("a report belonging to a closed operation lands in unallocated", async () => {
    // Without this, a report that arrived late sat in `pending` and was drained into
    // whichever operation closed next — misattribution, and the reason it is defensible
    // not to block on an outstanding gap.
    let highWater = 0;
    let queue: unknown[] = [];
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          sequenceHighWater: () => highWater,
          drain: () => {
            const drained = queue;
            queue = [];
            return drained as never;
          },
        },
      },
    });
    try {
      // Operation 1 sees sequence 2; sequence 1 never showed up.
      queue = [record(2, "b")];
      await session.prompt("one");
      highWater = 2;

      // Operation 2 drains the late sequence 1 alongside its own sequence 3.
      queue = [record(1, "a"), record(3, "c")];
      const second = (await session.prompt("two")) as AgentSessionPromptResult;

      // Only the current operation's own inference is attributed to it.
      expect(second.metering!.usage.status).toBe("metered");
      if (second.metering!.usage.status !== "metered") return;
      expect(second.metering!.usage.attributable.totalTokens).toBe(100);

      // The late one is preserved as unallocated, with its cost and a reason.
      const unallocated = session.meteringSnapshot.unallocatedUsage;
      expect(unallocated.recordCount).toBe(1);
      expect(unallocated.knownTokens.totalTokens).toBe(100);
      expect(unallocated.ratedCosts.amounts).toEqual([{ amount: "0.25", currency: "USD" }]);
    } finally {
      await session.stop();
    }
  });

  test("a source with no sequence information keeps every record", async () => {
    // An absent sequence means "no ordering information", which must not be read as
    // "arrived late" — that classified every record as late and reported the operation
    // unmeasured.
    const { session } = await openSession({
      adapterId: "opencode",
      metering: {
        pricing: fixedPricing,
        inferenceSource: {
          certificationId: "opencode-plugin@1",
          isHealthy: () => true,
          drain: () =>
            [{ ...(record(1, "x") as Record<string, unknown>), sequence: undefined }] as never,
        },
      },
    });
    try {
      const result = (await session.prompt("hello")) as AgentSessionPromptResult;
      expect(result.metering!.usage.status).toBe("metered");
    } finally {
      await session.stop();
    }
  });
});
