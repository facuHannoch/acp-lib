import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AgentSession,
  type AgentSessionConfig,
  type AgentSessionEvent,
  type AgentSessionPromptResult,
} from "../src/agent-session.ts";
import { AgentSessionOperationError } from "../src/metering/record.ts";
import type { PricingPolicy, PricingResolver } from "../src/metering/pricing.ts";

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
      expect(carried.version).toBe(2);
      expect(carried.totals.total.knownTokens).toBe(100);
      expect(carried.activeBaseline?.internalSessionId).toBe("usage-sess-1");
      expect(carried.ratedCosts).toEqual([{ amount: "0.000783", currency: "USD" }]);

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
      expect(attributable.ratedTotal?.amount).toBe("0.000783");
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
      expect(result.metering!.usage.attributable.ratedTotal).toBeNull();
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

  test("billing_required is refused until a certified integration exists", async () => {
    await expect(
      openSession({ metering: { enforcement: "billing_required" } }),
    ).rejects.toThrow(/certified metering integration/);
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
