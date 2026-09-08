import { describe, expect, test } from "bun:test";
import {
  EMPTY_MONEY_TOTAL,
  MAX_SCALE,
  addToTotal,
  isTotalComplete,
  mergeTotals,
  soleAmount,
  totalOf,
  addMoney,
  canonicalizeMoney,
  decimalFromNumber,
  isValidMoney,
  rateTokens,
  ratioOf,
  subtractMoney,
  sumMoneyByCurrency,
  type Money,
  type TokenUnitPrice,
} from "../src/metering/money.ts";

const USD = (amount: string, perTokens = 1_000_000): TokenUnitPrice => ({
  amount,
  currency: "USD",
  perTokens,
});

function rated(tokens: number, price: TokenUnitPrice): string {
  const result = rateTokens(tokens, price);
  if (!result.ok) throw new Error(`expected a rated amount, got: ${result.reason}`);
  return result.value.amount;
}

function summed(a: Money, b: Money): string {
  const result = addMoney(a, b);
  if (!result.ok) throw new Error(`expected a sum, got: ${result.reason}`);
  return result.value.amount;
}

describe("decimal string validation", () => {
  test("accepts canonical non-negative decimals", () => {
    for (const amount of ["0", "1", "1.25", "0.000001", "1234567890.123456789012"]) {
      expect(isValidMoney({ amount, currency: "USD" })).toBe(true);
    }
  });

  test("rejects signs, exponents, separators, leading zeroes, and non-finite forms", () => {
    const rejected = [
      "-1", // sign
      "+1",
      "1e6", // exponent
      "1E6",
      "1_000", // grouping separator
      "1,000",
      "01", // leading zero
      "00.5",
      ".5", // missing integer part
      "1.", // missing fraction digits
      "NaN",
      "Infinity",
      "",
      " 1 ",
    ];
    for (const amount of rejected) {
      expect(isValidMoney({ amount, currency: "USD" })).toBe(false);
    }
  });

  test("requires a non-empty currency", () => {
    expect(isValidMoney({ amount: "1", currency: "" })).toBe(false);
  });

  test("canonicalizes trailing fractional zeroes and zero itself", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["0.50", "0.5"],
      ["0.0", "0"],
      ["0", "0"],
      ["1.2500", "1.25"],
      ["10.000", "10"],
    ];
    for (const [input, expected] of cases) {
      const result = canonicalizeMoney({ amount: input, currency: "USD" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.amount).toBe(expected);
    }
  });
});

describe("rating tokens at a unit price", () => {
  test("rates the spec's worked example exactly", () => {
    // §6: 30k tokens at $1.25 per 1M = 0.0375
    expect(rated(30_000, USD("1.25"))).toBe("0.0375");
  });

  test("zero tokens rate to canonical zero, not 0.000000000000", () => {
    expect(rated(0, USD("1.25"))).toBe("0");
  });

  test("is exact where binary floating point is not", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754; the decimal path must not inherit that.
    const a = { amount: "0.1", currency: "USD" };
    const b = { amount: "0.2", currency: "USD" };
    expect(summed(a, b)).toBe("0.3");
    // 3 tokens at 0.1 per token is exactly 0.3, not 0.30000000000000004.
    expect(rated(3, USD("0.1", 1))).toBe("0.3");
  });

  test("honours perTokens rather than assuming per-million pricing", () => {
    expect(rated(1_000, USD("2", 1_000))).toBe("2");
    expect(rated(1_000, USD("2", 1_000_000))).toBe("0.002");
    expect(rated(7, USD("3", 1))).toBe("21");
  });

  test("rounds half-even at scale 12 when the division does not terminate", () => {
    // 1 token at 1/3 per 1M: 0.000000333333333333... → scale 12 → 0.000000333333
    expect(rated(1, USD("0.333333333333333", 1_000_000))).toBe("0.000000333333");
    // A true tie rounds to the even neighbour in both directions, and the result is then
    // canonicalized — so the tie that rounds down to zero renders as "0", not "0.000…".
    // 5 * 10^-13 = 0.0000000000005, exactly half a scale-12 ulp, between 0 and 1 → 0.
    expect(rated(5, USD("0.0000000000001", 1))).toBe("0");
    // 15 * 10^-13 = 0.0000000000015, between 1 and 2 → 2.
    expect(rated(15, USD("0.0000000000001", 1))).toBe("0.000000000002");
    // 25 * 10^-13 = 0.0000000000025, between 2 and 3 → 2. Half-up would give 3.
    expect(rated(25, USD("0.0000000000001", 1))).toBe("0.000000000002");
  });

  test("rounds to at most MAX_SCALE fractional digits", () => {
    const amount = rated(1, USD("0.1234567890123456789", 1));
    const fraction = amount.split(".")[1] ?? "";
    expect(fraction.length).toBeLessThanOrEqual(MAX_SCALE);
  });

  test("handles large token counts without precision loss", () => {
    // Beyond 2^53 products, float arithmetic would drift; BigInt does not.
    expect(rated(9_007_199_254_740_991, USD("1", 1))).toBe("9007199254740991");
  });

  test("rejects invalid token counts and unit prices instead of guessing", () => {
    expect(rateTokens(-1, USD("1")).ok).toBe(false);
    expect(rateTokens(1.5, USD("1")).ok).toBe(false);
    expect(rateTokens(Number.NaN, USD("1")).ok).toBe(false);
    expect(rateTokens(10, USD("1", 0)).ok).toBe(false);
    expect(rateTokens(10, USD("1", -1_000)).ok).toBe(false);
    expect(rateTokens(10, USD("1", 1.5)).ok).toBe(false);
    expect(rateTokens(10, USD("1e-6")).ok).toBe(false);
    expect(rateTokens(10, { amount: "1", currency: "", perTokens: 1 }).ok).toBe(false);
  });

  test("carries the unit price currency onto the rated amount", () => {
    const result = rateTokens(1_000, { amount: "1", currency: "EUR", perTokens: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe("EUR");
  });
});

describe("summing rated amounts", () => {
  test("adds same-currency amounts exactly and canonically", () => {
    expect(summed({ amount: "0.0375", currency: "USD" }, { amount: "0.125", currency: "USD" })).toBe(
      "0.1625",
    );
    expect(summed({ amount: "0", currency: "USD" }, { amount: "0", currency: "USD" })).toBe("0");
  });

  test("an operation total is the exact sum of already-rounded subtotals", () => {
    // Each category subtotal rounds independently; the total never re-rounds them, so
    // the engraved subtotals always add up to the engraved total.
    const subtotals = [
      rateTokens(25_000, USD("1.25")),
      rateTokens(5_000, USD("0.3")),
      rateTokens(1_200, USD("10")),
    ].map((r) => {
      if (!r.ok) throw new Error(r.reason);
      return r.value;
    });
    const total = sumMoneyByCurrency(subtotals);
    expect(total.ok).toBe(true);
    if (!total.ok) return;
    expect(subtotals.map((s) => s.amount)).toEqual(["0.03125", "0.0015", "0.012"]);
    expect(total.value).toEqual([{ amount: "0.04475", currency: "USD" }]);
  });

  test("cross-operation accumulation does not re-round", () => {
    // Three operations each rated at the scale-12 floor. Accumulating them must reach
    // 0.000000000003 — a running total that re-rounded each step would stay at the floor.
    const one: Money = { amount: "0.000000000001", currency: "USD" };
    const total = sumMoneyByCurrency([one, one, one]);
    expect(total.ok).toBe(true);
    if (!total.ok) return;
    expect(total.value).toEqual([{ amount: "0.000000000003", currency: "USD" }]);
  });

  test("refuses to sum across currencies", () => {
    const mixed = addMoney({ amount: "1", currency: "USD" }, { amount: "1", currency: "EUR" });
    expect(mixed.ok).toBe(false);
    if (mixed.ok) return;
    expect(mixed.reason).toContain("USD");
    expect(mixed.reason).toContain("EUR");
  });

  test("keeps at most one accumulated amount per currency, never merging them", () => {
    const result = sumMoneyByCurrency([
      { amount: "1.5", currency: "USD" },
      { amount: "2", currency: "EUR" },
      { amount: "0.5", currency: "USD" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { amount: "2", currency: "USD" },
      { amount: "2", currency: "EUR" },
    ]);
  });

  test("rejects a malformed operand rather than coercing it", () => {
    expect(addMoney({ amount: "1e3", currency: "USD" }, { amount: "1", currency: "USD" }).ok).toBe(
      false,
    );
  });
});

describe("provider-reported JSON number costs", () => {
  test("converts plain values to canonical decimal strings", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "0"],
      [1, "1"],
      [0.5, "0.5"],
      [1.25, "1.25"],
      [123.456, "123.456"],
    ];
    for (const [input, expected] of cases) {
      const result = decimalFromNumber(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(expected);
    }
  });

  test("expands exponent notation into plain decimal form", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [1e-7, "0.0000001"],
      [1.5e-7, "0.00000015"],
      [1e21, "1000000000000000000000"],
      [1.5e21, "1500000000000000000000"],
    ];
    for (const [input, expected] of cases) {
      const result = decimalFromNumber(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(expected);
    }
  });

  test("preserves the shortest round-trippable representation the SDK delivered", () => {
    // 0.1 + 0.2 parses to a float whose shortest representation is 0.30000000000000004.
    // The conversion must preserve that, not silently tidy it into 0.3: the number is
    // what the provider reported, and core does not improve it.
    const result = decimalFromNumber(0.1 + 0.2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("0.30000000000000004");
  });

  test("every converted value is accepted back as canonical money", () => {
    for (const input of [0, 0.5, 1e-7, 1.5e21, 0.1 + 0.2]) {
      const result = decimalFromNumber(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(isValidMoney({ amount: result.value, currency: "USD" })).toBe(true);
    }
  });

  test("rejects negative and non-finite costs", () => {
    for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decimalFromNumber(input).ok).toBe(false);
    }
  });
});

describe("reconciliation arithmetic", () => {
  test("subtracts same-currency amounts exactly", () => {
    expect(subtractMoney({ amount: "0.00533386", currency: "USD" }, { amount: "0.00348629", currency: "USD" }))
      .toEqual({ amount: "0.00184757", currency: "USD" });
  });

  test("a cumulative figure that went down is null, not a negative", () => {
    // A provider counter that decreased restarted; treating it as arithmetic hides that.
    expect(subtractMoney({ amount: "1", currency: "USD" }, { amount: "2", currency: "USD" })).toBeNull();
  });

  test("refuses to subtract across currencies", () => {
    expect(subtractMoney({ amount: "2", currency: "USD" }, { amount: "1", currency: "EUR" })).toBeNull();
  });

  test("expresses how far a rated cost is from the provider's own figure", () => {
    // The measured tool-call turns: 3 tool calls under-reported by 3.43x, 1 by 2.03x.
    expect(ratioOf({ amount: "0.00924448", currency: "USD" }, { amount: "0.00269497", currency: "USD" }))
      .toBe("3.430272");
    expect(ratioOf({ amount: "0.00532939", currency: "USD" }, { amount: "0.00262617", currency: "USD" }))
      .toBe("2.029339");
    // A turn with no hidden inferences reconciles to exactly 1.
    expect(ratioOf({ amount: "0.00348629", currency: "USD" }, { amount: "0.00348629", currency: "USD" }))
      .toBe("1");
  });

  test("a ratio against nothing is not a number", () => {
    expect(ratioOf({ amount: "1", currency: "USD" }, { amount: "0", currency: "USD" })).toBeNull();
    expect(ratioOf({ amount: "1", currency: "USD" }, { amount: "1", currency: "EUR" })).toBeNull();
  });
});

describe("MoneyTotal — a total that cannot hide what it dropped", () => {
  test("an unusable contribution is counted, never a silent no-op", () => {
    // The whole point: `if (sum.ok) total = sum.value` let six separate sites turn a
    // failure into a no-op. addToTotal has no `.ok` to forget.
    let total = addToTotal(EMPTY_MONEY_TOTAL, { amount: "1", currency: "USD" });
    total = addToTotal(total, null);
    total = addToTotal(total, { amount: "1e6", currency: "USD" });
    expect(total.amounts).toEqual([{ amount: "1", currency: "USD" }]);
    expect(total.unaccounted).toBe(2);
    expect(isTotalComplete(total)).toBe(false);
  });

  test("currencies coexist instead of one being dropped", () => {
    let total = addToTotal(EMPTY_MONEY_TOTAL, { amount: "10", currency: "USD" });
    total = addToTotal(total, { amount: "10", currency: "EUR" });
    total = addToTotal(total, { amount: "5", currency: "USD" });
    expect(total.amounts).toEqual([
      { amount: "15", currency: "USD" },
      { amount: "10", currency: "EUR" },
    ]);
    expect(isTotalComplete(total)).toBe(true);
  });

  test("soleAmount refuses anything ambiguous", () => {
    const usd = addToTotal(EMPTY_MONEY_TOTAL, { amount: "1", currency: "USD" });
    expect(soleAmount(usd)).toEqual({ amount: "1", currency: "USD" });
    // Two currencies: there is no single figure to show.
    expect(soleAmount(addToTotal(usd, { amount: "1", currency: "EUR" }))).toBeNull();
    // Something was dropped: the figure would be a lower bound presented as a total.
    expect(soleAmount(addToTotal(usd, null))).toBeNull();
    expect(soleAmount(EMPTY_MONEY_TOTAL)).toBeNull();
  });

  test("merging preserves both sides' unaccounted counts", () => {
    const a = addToTotal(addToTotal(EMPTY_MONEY_TOTAL, { amount: "1", currency: "USD" }), null);
    const b = addToTotal(addToTotal(EMPTY_MONEY_TOTAL, { amount: "2", currency: "EUR" }), null);
    const merged = mergeTotals(a, b);
    expect(merged.amounts).toEqual([
      { amount: "1", currency: "USD" },
      { amount: "2", currency: "EUR" },
    ]);
    expect(merged.unaccounted).toBe(2);
  });

  test("totalOf carries a null through as unaccounted, not as zero", () => {
    expect(totalOf(null)).toEqual({ amounts: [], unaccounted: 1 });
    expect(totalOf({ amount: "0", currency: "USD" })).toEqual({
      amounts: [{ amount: "0", currency: "USD" }],
      unaccounted: 0,
    });
  });
});
