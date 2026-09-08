// Money and token unit prices. See 9-6-SPEC-metering.md §6.
//
// Every amount is a canonical, non-negative plain decimal STRING, and all arithmetic
// runs on BigInt. Binary floating point never touches a rated cost: `0.1 + 0.2` must not
// be able to make a historical record irreproducible, and records are engraved once and
// read back years later.
//
// Rating is `tokens * unitPrice.amount / unitPrice.perTokens`, evaluated exactly and then
// rounded ONCE to scale 12 using round-half-even. Category subtotals round independently;
// sums of already-rounded subtotals are exact and are never re-rounded.

/** Maximum fractional decimal places of a rated result. */
export const MAX_SCALE = 12;

/** Canonical decimal input: no sign, exponent, grouping separator, or leading zero. */
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface TokenUnitPrice {
  readonly amount: string;
  readonly currency: string;
  /** Tokens the amount buys, normally 1_000_000. Explicit rather than encoded in a name. */
  readonly perTokens: number;
}

export type MoneyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** An exact non-negative decimal: `units / 10^scale`. Internal representation only. */
interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/** Parse a canonical decimal string. Rejects anything DECIMAL_PATTERN does not accept. */
export function parseDecimal(text: string): Decimal | null {
  if (typeof text !== "string" || !DECIMAL_PATTERN.test(text)) return null;
  const dot = text.indexOf(".");
  if (dot === -1) return { units: BigInt(text), scale: 0 };
  const fraction = text.slice(dot + 1);
  return { units: BigInt(text.slice(0, dot) + fraction), scale: fraction.length };
}

/** Render a decimal canonically: trailing fractional zeroes trimmed, zero as "0". */
export function formatDecimal(value: Decimal): string {
  if (value.scale === 0) return value.units.toString();
  const digits = value.units.toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Rescale to a common scale so two decimals can be compared or added exactly. */
function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * pow10(scale - a.scale),
    b: b.units * pow10(scale - b.scale),
    scale,
  };
}

/**
 * Divide non-negative bigints, rounding half-even (banker's rounding).
 *
 * Half-even rather than half-up because subtotals are summed: half-up biases every tie
 * in the same direction, so a long session accumulates a systematic overcharge.
 */
function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const doubled = remainder * 2n;
  if (doubled > denominator) return quotient + 1n;
  if (doubled < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Validate a canonical money value without interpreting it. */
export function isValidMoney(value: Money): boolean {
  return (
    typeof value?.currency === "string" &&
    value.currency.length > 0 &&
    parseDecimal(value.amount) !== null
  );
}

/** Canonicalize a money amount, e.g. "0.50" → "0.5", "0.0" → "0". */
export function canonicalizeMoney(value: Money): MoneyResult<Money> {
  if (typeof value?.currency !== "string" || value.currency.length === 0) {
    return { ok: false, reason: "currency must be a non-empty string" };
  }
  const parsed = parseDecimal(value.amount);
  if (!parsed) return { ok: false, reason: `amount ${JSON.stringify(value.amount)} is not a canonical decimal` };
  return { ok: true, value: Object.freeze({ amount: formatDecimal(parsed), currency: value.currency }) };
}

function validateUnitPrice(price: TokenUnitPrice): MoneyResult<{ amount: Decimal; scale: bigint }> {
  if (typeof price?.currency !== "string" || price.currency.length === 0) {
    return { ok: false, reason: "unit price currency must be a non-empty string" };
  }
  if (!Number.isSafeInteger(price.perTokens) || price.perTokens <= 0) {
    return { ok: false, reason: `perTokens ${String(price.perTokens)} must be a positive safe integer` };
  }
  const amount = parseDecimal(price.amount);
  if (!amount) {
    return { ok: false, reason: `unit price ${JSON.stringify(price.amount)} is not a canonical decimal` };
  }
  return { ok: true, value: { amount, scale: BigInt(price.perTokens) } };
}

/**
 * Rate a token count at a unit price.
 *
 * Exact value is `tokens * amount / perTokens`; it is evaluated in full precision and
 * rounded exactly once, to MAX_SCALE, half-even.
 */
export function rateTokens(tokens: number, price: TokenUnitPrice): MoneyResult<Money> {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    return { ok: false, reason: `token count ${String(tokens)} must be a non-negative safe integer` };
  }
  const validated = validateUnitPrice(price);
  if (!validated.ok) return validated;
  const { amount, scale: perTokens } = validated.value;

  // tokens * (units / 10^scale) / perTokens, expressed at MAX_SCALE:
  //   numerator   = tokens * units * 10^MAX_SCALE
  //   denominator = perTokens * 10^scale
  const numerator = BigInt(tokens) * amount.units * pow10(MAX_SCALE);
  const denominator = perTokens * pow10(amount.scale);
  const units = divideRoundHalfEven(numerator, denominator);
  return {
    ok: true,
    value: Object.freeze({
      amount: formatDecimal({ units, scale: MAX_SCALE }),
      currency: price.currency,
    }),
  };
}

/**
 * Add money values exactly. Same-currency only — core never converts or compares across
 * currencies, so a mixed-currency sum is an error rather than a silent coercion.
 *
 * Inputs are already-engraved subtotals at scale <= MAX_SCALE, so the sum is exact and is
 * never re-rounded. This is also the cross-operation accumulation rule for
 * `AgentSessionMeteringState.ratedCosts`.
 */
export function addMoney(a: Money, b: Money): MoneyResult<Money> {
  if (a.currency !== b.currency) {
    return { ok: false, reason: `cannot add ${a.currency} to ${b.currency}` };
  }
  const left = parseDecimal(a.amount);
  const right = parseDecimal(b.amount);
  if (!left || !right) return { ok: false, reason: "operand is not a canonical decimal" };
  const aligned = align(left, right);
  return {
    ok: true,
    value: Object.freeze({
      amount: formatDecimal({ units: aligned.a + aligned.b, scale: aligned.scale }),
      currency: a.currency,
    }),
  };
}

/**
 * Sum money values, keeping one accumulated amount per currency and never merging two.
 * Used for operation totals and for `ratedCosts` accumulation.
 */
export function sumMoneyByCurrency(values: readonly Money[]): MoneyResult<readonly Money[]> {
  const totals = new Map<string, Money>();
  for (const value of values) {
    const existing = totals.get(value.currency);
    if (!existing) {
      const canonical = canonicalizeMoney(value);
      if (!canonical.ok) return canonical;
      totals.set(value.currency, canonical.value);
      continue;
    }
    const sum = addMoney(existing, value);
    if (!sum.ok) return sum;
    totals.set(value.currency, sum.value);
  }
  return { ok: true, value: Object.freeze([...totals.values()]) };
}

/**
 * Subtract `b` from `a`, or null when the result would be negative or currencies differ.
 *
 * Null rather than a negative: a cumulative provider figure that went DOWN is not a
 * refund, it is a counter that restarted, and treating it as arithmetic would hide that.
 */
export function subtractMoney(a: Money, b: Money): Money | null {
  if (a.currency !== b.currency) return null;
  const left = parseDecimal(a.amount);
  const right = parseDecimal(b.amount);
  if (!left || !right) return null;
  const aligned = align(left, right);
  if (aligned.a < aligned.b) return null;
  return Object.freeze({
    amount: formatDecimal({ units: aligned.a - aligned.b, scale: aligned.scale }),
    currency: a.currency,
  });
}

/**
 * Ratio of two same-currency amounts, as a decimal string at scale 6.
 *
 * Used to express how far a rated cost is from the provider's own figure: "3.43" means
 * the provider charged 3.43x what we accounted for. Returns null when the denominator is
 * zero or the currencies differ — a ratio against nothing is not a number.
 */
export function ratioOf(numerator: Money, denominator: Money): string | null {
  if (numerator.currency !== denominator.currency) return null;
  const top = parseDecimal(numerator.amount);
  const bottom = parseDecimal(denominator.amount);
  if (!top || !bottom || bottom.units === 0n) return null;
  const RATIO_SCALE = 6;
  // (top.units / 10^top.scale) / (bottom.units / 10^bottom.scale), at RATIO_SCALE
  const scaled = top.units * pow10(bottom.scale) * pow10(RATIO_SCALE);
  const units = divideRoundHalfEven(scaled, bottom.units * pow10(top.scale));
  return formatDecimal({ units, scale: RATIO_SCALE });
}

/**
 * A running money total that cannot hide what it failed to include.
 *
 * `Money[]` had no way to say "one contribution did not make it", so every accumulation
 * site wrote `if (sum.ok) total = sum.value` and a failure silently became a no-op. That
 * single missing concept produced six separate under-reporting bugs, including an
 * operation that dropped half its cost while reporting itself fully priced.
 *
 * Tokens never had this problem: `UsageCategoryTotal` forces a coverage answer. This is the
 * same idea for money.
 */
export interface MoneyTotal {
  /** One accumulated amount per currency. Empty when nothing was added. */
  readonly amounts: readonly Money[];
  /**
   * Contributions that could not be included — absent, malformed, or uncombinable.
   *
   * Non-zero means `amounts` is a LOWER BOUND.
   */
  readonly unaccounted: number;
}

export const EMPTY_MONEY_TOTAL: MoneyTotal = Object.freeze({
  amounts: Object.freeze([]),
  unaccounted: 0,
});

/**
 * Add a contribution to a total.
 *
 * Deliberately returns a total rather than a Result: there is no `.ok` to forget, so a
 * failure cannot silently become a no-op. A null or unusable contribution is COUNTED.
 */
export function addToTotal(total: MoneyTotal, addition: Money | null): MoneyTotal {
  if (!addition) {
    return Object.freeze({ amounts: total.amounts, unaccounted: total.unaccounted + 1 });
  }
  const canonical = canonicalizeMoney(addition);
  if (!canonical.ok) {
    return Object.freeze({ amounts: total.amounts, unaccounted: total.unaccounted + 1 });
  }

  const amounts: Money[] = [];
  let merged = false;
  for (const existing of total.amounts) {
    if (existing.currency !== canonical.value.currency) {
      amounts.push(existing);
      continue;
    }
    const sum = addMoney(existing, canonical.value);
    if (!sum.ok) {
      // Cannot happen for two canonical same-currency amounts, but counting beats
      // assuming: an uncounted drop is the bug this type exists to prevent.
      return Object.freeze({ amounts: total.amounts, unaccounted: total.unaccounted + 1 });
    }
    amounts.push(sum.value);
    merged = true;
  }
  if (!merged) amounts.push(canonical.value);
  return Object.freeze({ amounts: Object.freeze(amounts), unaccounted: total.unaccounted });
}

/** Merge one total into another, preserving both unaccounted counts. */
export function mergeTotals(a: MoneyTotal, b: MoneyTotal): MoneyTotal {
  let merged = a;
  for (const amount of b.amounts) merged = addToTotal(merged, amount);
  return Object.freeze({ amounts: merged.amounts, unaccounted: merged.unaccounted + b.unaccounted });
}

/** True when every contribution was accounted for. */
export function isTotalComplete(total: MoneyTotal): boolean {
  return total.unaccounted === 0;
}

/**
 * The single amount a total represents, or null.
 *
 * Null whenever there is not exactly one — several currencies, none, or something
 * unaccounted. Callers that want one number must therefore handle the ambiguous case
 * rather than reading `amounts[0]` and hoping.
 */
export function soleAmount(total: MoneyTotal): Money | null {
  return total.unaccounted === 0 && total.amounts.length === 1 ? total.amounts[0]! : null;
}

/** Build a total from a single known amount. */
export function totalOf(amount: Money | null): MoneyTotal {
  return addToTotal(EMPTY_MONEY_TOTAL, amount);
}

/**
 * Convert an ACP-reported JSON number cost into a canonical decimal string.
 *
 * `String(n)` is already the shortest round-trippable representation; this only expands
 * exponent notation into plain decimal form. It preserves the number the SDK delivered
 * and cannot recover precision JSON parsing already lost — the result stays explicitly
 * provider-reported, never billing-grade.
 */
export function decimalFromNumber(value: number): MoneyResult<string> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: `cost ${String(value)} is not a finite number` };
  }
  if (value < 0) return { ok: false, reason: `cost ${String(value)} is negative` };

  const text = String(value);
  const exponentIndex = text.search(/[eE]/);
  if (exponentIndex === -1) {
    const parsed = parseDecimal(text);
    return parsed ? { ok: true, value: formatDecimal(parsed) } : { ok: false, reason: `cost ${text} is not representable` };
  }

  const exponent = Number(text.slice(exponentIndex + 1));
  const mantissa = text.slice(0, exponentIndex);
  const dot = mantissa.indexOf(".");
  const digits = dot === -1 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  const mantissaScale = dot === -1 ? 0 : mantissa.length - dot - 1;
  // value = digits / 10^mantissaScale * 10^exponent = digits / 10^(mantissaScale - exponent)
  const scale = mantissaScale - exponent;
  const units = scale < 0 ? BigInt(digits) * pow10(-scale) : BigInt(digits);
  return { ok: true, value: formatDecimal({ units, scale: Math.max(scale, 0) }) };
}
