# AgentSession metering specification

Status: revised design; implementation pending.

This document defines consumer-facing context-window, token-usage, and cost metering for
`AgentSession`. It is deliberately separate from transcript persistence and from any CLI
presentation. A consumer may bind the same data to a dashboard, database, API, command,
or terminal UI.

The design has three goals:

1. Keep the latest context-window pressure visible on the live `AgentSession`.
2. Return one immutable, historically priced metering record for every operation that
   may consume model tokens.
3. Let the consumer own durable accounting without making transcripts or
   `SessionManager` an accounting database.

This is metering telemetry, not a claim of provider-grade billing. ACP usage is optional,
experimental, and ambiguous about whether prompt usage is per-turn or cumulative. The
library must preserve what the harness reported, state the interpretation it applied,
and never fabricate a zero when information is unavailable. Billing-grade enforcement
is defined separately for certified integrations that observe the harness's model-call
path; it cannot be inferred from ACP usage alone.

---

## 1. Scope

### In scope

- Normalize ACP `PromptResponse.usage` into the public library contract.
- Correct the existing cache-field names and explicitly record the cumulative
  interpretation used for ACP usage.
- Track the active provider thread's latest context-window status.
- Calculate attributable token deltas from cumulative provider counters.
- Accumulate attributable usage over the stable `agentSessionId`, including handoffs and
  future provider changes.
- Resolve current pricing before an operation and engrave the applied price beside each
  attributable token category in the resulting record.
- Keep provider-reported cost distinct from library-rated cost.
- Return and emit operation metering records.
- Export and restore a versioned metering state so a consumer can preserve correct
  cumulative baselines across `AgentSession` object lifetimes.
- Support strict and best-effort ACP-derived metering without presenting either as
  billing-grade certification.
- Provide a pinned models.dev snapshot as the default pricing source while retaining
  consumer overrides.
- Engrave immutable pricing-source identity and metering provenance in every record.
- Represent usage observed outside an attributable library operation without silently
  assigning it to the next operation.
- Meter library-internal model operations used by handoff.

### Out of scope

- Storing a global usage history or dashboard table.
- Billing or charging an end user.
- Reconciliation with a provider billing API.
- Parsing harness-specific `/usage` prose.
- Subscription rate-limit or quota tracking.
- Inferring whether authentication uses an API key or a subscription.
- Transcript HMACs or transcript integrity.
- Treating a transcript as an accounting source of truth.
- Coordinating exclusive ownership when multiple live `AgentSession` objects load the
  same provider thread.
- Guaranteeing one record per underlying provider inference. An ACP prompt may hide
  retries, compaction, or multiple model calls.
- Certifying an OpenCode version/provider route for billing-required use. That contract
  is specified in `9-6-SPEC-opencode-certified-metering.md`.
- Treating models.dev or any other catalog as a provider invoice.

---

## 2. The four distinct quantities

The implementation must not collapse these concepts:

| Quantity | Meaning | Scope | ACP source |
|---|---|---|---|
| Context window | Tokens currently occupying the active model context | Current internal session | `usage_update.used` / `size` |
| Token usage | Tokens processed and reported by the harness | Interpreted cumulative internal-session counters, converted into operation deltas | `PromptResponse.usage` |
| Monetary cost | Provider-reported cumulative cost or a local rated amount | Internal session or operation | `usage_update.cost` / configured pricing |
| Subscription quota | Remaining allowance under an account plan | Provider account | Not standardized by ACP |

Subscription quota is not part of this feature. Missing usage must not be interpreted as
evidence that a user has a subscription: it can equally indicate an old harness, missing
implementation, failed operation, or provider defect.

---

## 3. Identity and aggregation

An `agentSessionId` is the stable logical identity. An `internalSessionId` names the
replaceable provider thread currently backing it.

Usage totals belong to the stable `AgentSession`:

```text
AgentSession A
  Claude internal thread 1   130k attributable tokens
  Codex internal thread 2     50k attributable tokens
  logical total              180k attributable tokens
```

Context does not aggregate:

```text
Claude internal thread 1     130k / 200k context
handoff
Codex internal thread 2      unknown, then 8k / 200k
```

After a provider-thread replacement, `session.contextWindow` becomes `null` until the
new active thread reports a context update. The old context snapshot may be present in a
previous operation record but is no longer current session state.

Every operation record snapshots the `agentSessionId`, `internalSessionId`, `adapterId`,
and model so later handoffs or configuration changes cannot rewrite historical meaning.

Correct delta attribution assumes one live metering owner per internal provider thread.
Two live `AgentSession` objects pointed at the same `internalSessionId` will independently
observe the same cumulative increments and can double-count them. ACP supplies no
cross-process lease. A consumer requiring this guarantee must enforce exclusive ownership
in its registry/database; library-level leases are out of scope for this pass.

---

## 4. ACP usage contract and interpretation

The installed ACP SDK is internally inconsistent. `PromptResponse.usage` describes token
usage "for this turn", while the individual `Usage` fields describe totals across all
turns or the session. ACP exposes no capability bit or discriminator that resolves the
conflict. The library therefore cannot claim cumulative semantics as a protocol fact.

This specification chooses the field-level cumulative interpretation for the derived ACP
backend because it is the only interpretation that permits operation deltas and agrees
with the session-wide description of `totalTokens`. The chosen interpretation is stamped
into provenance. Harnesses known or observed to emit per-turn usage must not use the
cumulative delta algorithm; until a separately tested interpreter exists, their ACP usage
is unavailable for attribution.

The current library contract also omits `totalTokens` and uses `cacheReadTokens` /
`cacheWriteTokens` instead of the ACP names `cachedReadTokens` /
`cachedWriteTokens`.

The normalized public type is:

```ts
export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}
```

Rules:

- Counters must be finite, non-negative safe integers.
- Required malformed counters make the report unavailable; they are never coerced to
  zero.
- `null` or absent optional counters remain absent. Absence does not mean zero.
- The raw ACP object is normalized at `AcpClient`; it must not be cast blindly.
- `AcpClient` exposes the normalized cumulative report but does not calculate prices or
  stable-AgentSession totals.
- Normalization validates field names and values; it does not prove whether the harness
  emitted cumulative or per-turn counters.
- No empirical heuristic may silently switch interpretations during a session. An
  interpretation is adapter/version evidence and part of record provenance.
- The misleading exported `Usage` type is replaced by or aliased to `TokenUsage` as part
  of the pre-1.0 compatibility change. The implementation plan must call this out in the
  changelog.

---

## 5. Context-window state

```ts
export interface ContextWindowStatus {
  readonly internalSessionId: string;
  readonly usedTokens: number;
  readonly sizeTokens: number;
  readonly remainingTokens: number;
  /** A ratio in [0, 1], not a percentage in [0, 100]. */
  readonly utilization: number;
  readonly observedAt: number;
}
```

Public surface:

```ts
session.contextWindow: ContextWindowStatus | null;
```

Semantics:

- `usedTokens` means tokens currently in context according to the harness.
- It is not the last message size, cumulative billed usage, or a prediction of the next
  request's exact input.
- `remainingTokens` is `max(0, sizeTokens - usedTokens)`.
- `utilization` is `usedTokens / sizeTokens`; a zero `sizeTokens` produces no valid
  snapshot rather than `Infinity`.
- A new valid update atomically replaces the previous snapshot.
- A stale update for a non-active internal session must not replace current state.
- `observedAt` is required because ACP does not guarantee when an agent will publish the
  next update.
- A new/load/resume/handoff/provider transition resets the value to `null` before
  accepting an update for the new internal session.

Session notification:

```ts
{
  kind: "context_window_changed";
  contextWindow: ContextWindowStatus | null;
}
```

The existing raw/folded activity event remains available. The session property and
notification are the authoritative non-polling consumer API.

Provider cost is deliberately not nested in `ContextWindowStatus`. ACP transports both
in one `usage_update`, but they have different lifecycles and a cost-only change should
not make a context value look newly observed. Cost is exposed separately as
`session.providerCost` and copied to an operation only as `providerCostAfter`.

---

## 6. Money and unit prices

Money is represented as a canonical, non-negative plain decimal string. Accepted input
matches `0|[1-9][0-9]*(\.[0-9]+)?`: no sign, exponent, grouping separator, leading zero,
`NaN`, or infinity. Canonical output removes trailing fractional zeroes and represents
zero as `"0"`.

```ts
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface TokenUnitPrice {
  readonly amount: string;
  readonly currency: string;
  readonly perTokens: number;
}
```

`perTokens` is normally `1_000_000`, but it is explicit rather than encoded in a property
name. It must be a positive safe integer.

Local rated costs use arbitrary-precision integer/decimal arithmetic, a maximum result
scale of 12 fractional decimal places, and round-half-even when division does not
terminate within that scale. Each category subtotal is rounded independently; an
operation total is the exact decimal sum of those engraved subtotals and is then
canonicalized. No rounding to a currency's display/minor-unit scale occurs in core—the
consumer owns display formatting.

Cross-operation accumulation follows the same engraved boundary. For each currency,
`AgentSessionMeteringState.ratedCosts` is the exact decimal sum of immutable operation
`ratedTotal` values, each already rounded to at most scale 12. Totals are never
recomputed from cumulative tokens using the current catalog, and no second rounding step
is applied while accumulating operations.

An applied price is engraved beside the attributable token amount:

```ts
export interface PricedTokenAmount {
  /** Attributable counter delta reported for this category. */
  readonly reportedTokens: number;
  /** Tokens to which this category's unit price was applied. */
  readonly pricedTokens: number | null;
  readonly pricing:
    | {
        readonly unitPrice: TokenUnitPrice;
        readonly ratedCost: Money;
      }
    | null;
}
```

The example represents 30k reported input tokens where 5k cached tokens were declared
included in input, leaving 25k priced at the ordinary-input rate. `pricedTokens` is
`null` exactly when `pricing` is `null`; an unpriced record does not pretend an input
cache convention was applied.

Example:

```ts
{
  reportedTokens: 30_000,
  pricedTokens: 25_000,
  pricing: {
    unitPrice: {
      amount: "1.25",
      currency: "USD",
      perTokens: 1_000_000,
    },
    ratedCost: {
      amount: "0.0375",
      currency: "USD",
    },
  },
}
```

The record must contain the exact unit price used for that operation. A later pricing
change affects only later records. Historical interpretation must never require looking
up a mutable global pricing table. `ratedCost` is exact under the engraved schedule; it
is not asserted to match an upstream provider invoice.

ACP provider cost arrives as a JSON number. A valid finite non-negative value is
converted using JavaScript's shortest round-trippable decimal representation, expanding
exponent notation into the canonical plain-decimal form above. This preserves the number
the SDK delivered, but cannot recover precision already lost while parsing JSON. The
result remains explicitly provider-reported rather than billing-grade.

---

## 7. Pricing configuration and catalog provenance

The library ships a generated, pinned models.dev snapshot as its default pricing source.
The snapshot is an offline deterministic default, not an always-current catalog and not
a provider billing authority. Consumers may replace or extend it with a
`PricingResolver`. The library exports its default resolver so a consumer resolver can
delegate unmatched lookups to it.

Price provenance is immutable and copied into every priced record:

```ts
export type PricingSource =
  | {
      readonly kind: "models.dev";
      /** Immutable upstream Git commit used to produce the artifact. */
      readonly commit: string;
      /** SHA-256 of the exact generated catalog artifact shipped by the library. */
      readonly artifactSha256: string;
      readonly generatedAt: number;
    }
  | {
      readonly kind: "consumer_override";
      /** Stable identifier meaningful to the consumer, not a mutable display label. */
      readonly version: string;
    };
```

The generated snapshot converts source JSON numbers to canonical decimal strings at
build time. Runtime pricing never performs arithmetic using binary floating-point
catalog values. Snapshot date alone is not an identity; the upstream commit and artifact
digest are required.

```ts
export type TokenCategory =
  | "input"
  | "output"
  | "cached_read"
  | "cached_write"
  | "thought";

export interface PricingSchedule {
  /** Stable identifier for this schedule within its policy. */
  readonly tier: string;
  /** Machine-evaluable catalog conditions selecting this schedule. */
  readonly conditions: readonly PricingCondition[];
  /** Provider/harness counter convention used to avoid pricing cached input twice. */
  readonly cacheInputConvention: {
    readonly cachedRead: "included_in_input" | "excluded_from_input";
    readonly cachedWrite: "included_in_input" | "excluded_from_input";
  };
  readonly input: TokenUnitPrice;
  readonly output: TokenUnitPrice;
  readonly cachedRead?: TokenUnitPrice;
  readonly cachedWrite?: TokenUnitPrice;
  readonly thought?: TokenUnitPrice;
}

export type PricingCondition =
  | { readonly kind: "default" }
  | { readonly kind: "context_tokens_at_least"; readonly tokens: number }
  | { readonly kind: "service_tier"; readonly value: string }
  | { readonly kind: "batch"; readonly value: boolean }
  | {
      /** Versioned consumer condition for a schedule core does not model natively. */
      readonly kind: "consumer";
      readonly name: string;
      readonly value: string;
    };

export interface PricingPolicy {
  readonly source: PricingSource;
  /** Provider and model keys actually selected from the source. */
  readonly providerId: string;
  readonly modelId: string;
  /** Applicability is independent from whether a price happens to be present. */
  readonly categoryApplicability: Readonly<
    Record<TokenCategory, "applicable" | "not_applicable" | "unknown">
  >;
  readonly schedules: readonly PricingSchedule[];
}

export interface PricingContext {
  readonly scope: "operation" | "inference";
  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly operationId: string;
  readonly inferenceId?: string;
  readonly adapterId: string;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly operationKind: MeteredOperationKind;
  readonly at: number;
}

export type PricingResolver = (
  context: PricingContext,
) => PricingPolicy | null | Promise<PricingPolicy | null>;

export type PricingConfiguration = PricingResolver | false;
```

When `MeteringConfig.pricing` is absent, the library uses the pinned catalog resolver.
This changes the former meaning of absence: best-effort mode reports
`pricing_unavailable` only when the advertised provider/model cannot be matched or the
catalog lacks a complete applicable schedule. A consumer that intentionally wants no
local rating sets `pricing: false`.

The resolver runs before its token-consuming rating unit is sent. The ACP-derived backend
has one operation-level rating unit. A certified per-inference backend has one rating unit
per physical inference. This provides a preflight failure in strict modes and snapshots
the complete pricing policy in force at the start of that unit. The resolved policy is
held by the operation/inference even if external pricing configuration changes while it
runs.

The applicable schedule can depend on trusted facts unavailable to the outer
`AgentSession` before dispatch, including actual context/input size, provider service
tier, or batch execution. The implementation therefore freezes all applicable schedules
before sending and selects exactly one after those facts are observed. It never fetches
new prices after provider work. No matching schedule or multiple equally applicable
schedules is `pricing_unavailable`, not an arbitrary selection.

A condition may be evaluated only from a billing fact supplied by the active metering
backend and defined by that backend's contract. The ACP-derived backend does not know the
operation's causal context size: an attributable cumulative-counter delta is not active
context occupancy, and `contextAfter` is not causally tied to the operation. It therefore
cannot evaluate `context_tokens_at_least` from either value. Any policy whose applicable
schedule requires a fact the backend cannot supply is `pricing_unavailable`; core never
substitutes a proxy measurement.

Resolver outcomes are explicit:

- `pricing: false` produces `pricingStatus: "not_configured"` in best-effort mode and is
  a preflight configuration error in strict modes.
- A resolver returning `null` produces `pricingStatus: "pricing_unavailable"`; strict
  mode rejects before sending and best-effort proceeds unpriced.
- A resolver throwing/rejecting follows the same enforcement behavior as `null`, retains
  a safe string form in `pricingFailureReason`, and preserves the original error as the
  preflight error cause in strict modes.
- The resolver is invoked exactly once per rating unit: once per ACP operation or once
  per certified physical inference. A failure never triggers an automatic resolver or
  provider-operation retry.
- Schedule selection is deterministic from the frozen policy and recorded billing facts.

The library calculates one subtotal per reported attributable category. It does not
price `totalTokens` as an additional category, because that would double-count the
components.

Every unit price in one resolved schedule must use the same currency. A mixed-currency
schedule is invalid rather than partially summed.

The cache convention is part of the resolved schedule because it can vary by provider,
model, protocol, and harness normalization path. It is copied into `AttributableUsage`
so a historical record says which interpretation was applied. When a cache counter is
marked included, its delta is subtracted from the ordinary input delta before the input
price is applied, and the cache delta is priced separately. When excluded, ordinary
input is priced unchanged. A negative result is invalid telemetry/pricing, never clamped
to zero.

Using models.dev and OpenCode together reduces category/pricing drift because OpenCode
uses the same catalog ecosystem, but correctness is not automatic. OpenCode's provider
runtime produces normalized categories; models.dev independently supplies their prices.
A certified route must test both the normalization and completeness of the applicable
catalog entry. Missing catalog fields are unknown, never zero.

Likewise, a missing category price is not evidence that the category is inapplicable.
The catalog generator or a certified override must set `categoryApplicability`
explicitly. A selected schedule must price every category marked applicable that the
backend reports. A reported category marked `not_applicable` is contradictory evidence
and invalidates the policy/record rather than being ignored.

The real-harness matrix must also record the observed/documented convention per adapter
and provider route. That evidence validates the default resolver, but the engraved
schedule and source identity—not a mutable matrix—are the historical calculation
contract.

The active model is the plain advertised model string:

```ts
model: string | null;
```

`AgentSession` retains model configuration updates and snapshots the current value into
each record. No `source` wrapper is exposed. Strict metering cannot resolve
model-dependent pricing when the model is `null`; best-effort metering may continue with
unpriced tokens.

The default catalog resolver also requires a structured or certified `providerId`.
It must not guess a provider from an arbitrary model string. A built-in single-provider
adapter may supply a tested provider mapping; a multiplexing harness such as OpenCode
must report the selected provider through its certified integration. Without that
evidence the default resolver returns `null`.

---

## 8. Attributable operation usage

```ts
export interface AttributableUsage {
  /** Unpriced attributable usage before cache-convention adjustment. */
  readonly reportedDelta: TokenUsage;
  readonly pricingSource: PricingSource | null;
  readonly pricingKey:
    | {
        readonly providerId: string;
        readonly modelId: string;
        readonly tier: string;
      }
    | null;
  readonly cacheInputConvention: PricingSchedule["cacheInputConvention"] | null;
  readonly totalTokens: number;
  readonly input: PricedTokenAmount;
  readonly output: PricedTokenAmount;
  readonly cachedRead?: PricedTokenAmount;
  readonly cachedWrite?: PricedTokenAmount;
  readonly thought?: PricedTokenAmount;
  readonly ratedTotal: Money | null;
}
```

Pricing is attached only to attributable deltas, never to raw cumulative reports.
`reportedTokens` preserves each raw category delta. `pricedTokens` records the adjusted
quantity actually multiplied by the unit price. For every non-input category the two are
normally equal; input can differ according to `cacheInputConvention`.

`pricingSource` and `pricingKey` are either both present or both `null`. Together with
the per-category unit prices and rated subtotals they make a record reproducible without
consulting the library's current catalog.

Given cumulative totals:

```text
after operation 1:  50k
after operation 2: 100k
after operation 3: 130k
```

the attributable totals are:

```text
operation 1: 50k
operation 2: 50k
operation 3: 30k
```

### Trusted baselines

A delta is attributable only when one of these is true:

1. The library created the active internal session and therefore knows its counters began
   at zero.
2. A matching prior metering state was supplied when reopening.
3. A prior cumulative report was observed during the same live `AgentSession` lifetime.

A restored baseline matches only when its `agentSessionId`, `adapterId`, and
`internalSessionId` all match the session being opened. Mismatches are preflight errors in
telemetry-required mode and ignored with an explicit unavailable reason in best-effort
mode.

If any required cumulative counter decreases, the report is a counter reset, not a
negative operation. No attributable delta or rated amount is produced for that operation;
the new report becomes the next baseline in best-effort mode. Telemetry-required mode becomes
blocked as described below.

An optional category that first appears after an unknown/absent prior value cannot be
given an exact delta. Absence is not treated as zero except from a known-new-session
baseline.

---

## 9. Operation records

The library promises one record per ACP operation it can observe, not one record per
hidden model inference.

```ts
export type MeteredOperationKind =
  | "prompt"
  | "internal_command"
  | "handoff_summary"
  | "handoff_seed";

export type OperationOutcome = "completed" | "cancelled" | "error";

export type MeteringUsageResult =
  | {
      readonly status: "metered";
      readonly reportedCumulative: TokenUsage;
      readonly attributable: AttributableUsage;
    }
  | {
      readonly status:
        | "usage_unavailable"
        | "baseline_required"
        | "counter_reset";
      readonly reportedCumulative?: TokenUsage;
      readonly reason: string;
    };

export type MeteringPricingStatus =
  | "priced"
  | "not_configured"
  | "not_attributable"
  | "pricing_unavailable";

export interface ProviderIdentitySnapshot {
  readonly adapterId: string;
  /** Provider catalog key when established by structured evidence. */
  readonly providerId: string | null;
  readonly model: string | null;
}

export interface MeteringProvenance {
  /** Evidence class; certificationId names a concrete certified integration. */
  readonly source: "certified" | "acp_usage" | "none";
  /** Strength and location of the observed measurement. */
  readonly measurement:
    | "provider_normalized"
    | "acp_derived"
    | "unavailable";
  /** Whether model traffic was seen by the collector; not a network-isolation claim. */
  readonly routing: "observed" | "unknown";
  /** Whether measured usage can be assigned without ambiguity. */
  readonly attribution: "complete" | "partial" | "unavailable";
  /** Present for ACP-derived cumulative delta records. */
  readonly counterInterpretation?: "cumulative" | "per_turn";
  /** Present only when a recognized certified integration produced the record. */
  readonly certificationId?: string;
}

export interface OperationMeteringRecord {
  readonly operationId: string;
  readonly operationKind: MeteredOperationKind;
  readonly outcome: OperationOutcome;
  readonly startedAt: number;
  readonly completedAt: number;

  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly provider: ProviderIdentitySnapshot;
  readonly provenance: MeteringProvenance;

  readonly usage: MeteringUsageResult;
  readonly pricingStatus: MeteringPricingStatus;
  readonly pricingFailureReason?: string;
  /** Latest observation received by completion; not guaranteed to include this operation. */
  readonly contextAfter: ContextWindowStatus | null;
  /** Latest cumulative provider observation; not asserted to be an invoice. */
  readonly providerCostAfter: ProviderCostSnapshot | null;

  /** State the consumer can persist and pass to a reopened AgentSession. */
  readonly nextState: AgentSessionMeteringState;
}
```

The record and all nested objects/arrays are immutable snapshots. It does not contain the
prompt, response, tool output, or transcript. `operationId` is the join key a consumer
uses to store conversation content and accounting separately or together.

An unavailable record is still a record. It proves an operation occurred while avoiding
the false assertion that it cost zero. An ordinary ACP-derived record uses
`source: "acp_usage"`, `measurement: "acp_derived"`, `routing: "unknown"`, and no
certification id. Provenance fields describe evidence; consumers cannot promote a
record by setting them in configuration.

Usage and pricing availability are orthogonal. A best-effort subscription session can
have `usage.status: "metered"` with `pricingStatus: "not_configured"`; an operation with
no attributable delta uses `pricingStatus: "not_attributable"`. A strict mode uses
`pricing_unavailable` when reported attributable categories cannot all be priced.

---

## 10. Prompt and handoff results

Metering is owned by the stable-session layer. Raw `AcpClient` callers receive normalized
cumulative `TokenUsage`; `AgentSession` callers receive the enriched record.

```ts
export interface AgentSessionPromptResult extends PromptResult {
  readonly operationId: string;
  readonly metering: OperationMeteringRecord;
}
```

`AgentSession.prompt()` and `executeInternalSessionCommand()` return
`AgentSessionPromptResult`. The existing `PromptResult` remains the lower-level common
client result.

The current public turn id is reused as `operationId`; the implementation must not mint a
second unrelated identifier for the same prompt.

Handoff can contain two token-consuming operations:

```ts
export interface HandoffResult {
  // existing fields
  readonly meteringRecords: readonly OperationMeteringRecord[];
}
```

- An automatically generated summary produces `handoff_summary` on the old internal
  session.
- Continuation seeding produces `handoff_seed` on the new internal session.
- Child operation ids are deterministic and namespaced by the existing handoff id:
  `${handoffId}:summary` and `${handoffId}:seed`. A supplied summary means the former id
  is never emitted. The handoff id and child operation ids are not minted independently.
- Supplying `HandoffOptions.summary` removes the summary-generation operation, but the
  seed remains metered.
- Both records contribute to the stable `AgentSession` totals.
- A failed seed still emits any summary record and a seed record describing the failed
  or unavailable operation. The typed handoff error and failure notification carry the
  records because a rejected handoff does not return `HandoffResult`.

---

## 11. Live metering state and restoration

`AgentSession` retains bounded state, not an unbounded operation history.

```ts
export interface UsageCategoryTotal {
  /** Sum of deltas that were actually attributable; always a lower bound. */
  readonly knownTokens: number;
  /** Applicable operations that supplied an attributable value, including explicit 0. */
  readonly attributedOperationCount: number;
  /** Operations explicitly known not to use this category. */
  readonly notApplicableOperationCount: number;
  /** Applicable/unknown operations for which this category could not be established. */
  readonly unavailableOperationCount: number;
  readonly coverage: "complete" | "partial" | "none" | "not_applicable";
}

export interface AggregateUsageTotal {
  /** Sum of attributable aggregate-token deltas; always a lower bound. */
  readonly knownTokens: number;
  /** Operations that supplied an attributable aggregate-token value. */
  readonly attributedOperationCount: number;
  /** Operations for which aggregate-token usage could not be established. */
  readonly unavailableOperationCount: number;
  readonly coverage: "complete" | "partial" | "none";
}

export interface UsageTotals {
  readonly total: AggregateUsageTotal;
  readonly input: UsageCategoryTotal;
  readonly output: UsageCategoryTotal;
  readonly cachedRead: UsageCategoryTotal;
  readonly cachedWrite: UsageCategoryTotal;
  readonly thought: UsageCategoryTotal;
}

export interface UnallocatedUsageState {
  /** Number of observed inference records not assigned to an operation. */
  readonly recordCount: number;
  /** Known unallocated tokens. Absent categories remain absent, never zero-filled. */
  readonly knownTokens: Partial<TokenUsage>;
  /** Rated unallocated amounts, accumulated separately by currency. */
  readonly ratedCosts: readonly Money[];
}

export interface MeteringBaseline {
  readonly adapterId: string;
  readonly internalSessionId: string;
  readonly reportedUsage: TokenUsage;
  readonly providerCost: ProviderCostSnapshot | null;
}

export interface AgentSessionMeteringState {
  readonly version: 2;
  readonly agentSessionId: string;
  readonly operationCount: number;
  readonly meteredOperationCount: number;
  readonly unmeteredOperationCount: number;
  readonly totals: UsageTotals;
  readonly ratedCosts: readonly Money[];
  readonly unallocatedUsage: UnallocatedUsageState;
  readonly activeBaseline: MeteringBaseline | null;
}

export interface AgentSessionMeteringSnapshot extends AgentSessionMeteringState {
  readonly enforcement: MeteringEnforcement;
  readonly restoration:
    | { readonly status: "not_provided" }
    | { readonly status: "restored"; readonly version: 2 }
    | {
        readonly status: "ignored";
        readonly reason:
          | "initial_state_version_unsupported"
          | "initial_state_identity_mismatch";
        readonly providedVersion?: number;
      };
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  readonly lastOperation: OperationMeteringRecord | null;
}
```

Public surface:

```ts
session.metering: AgentSessionMeteringSnapshot;
```

`ratedCosts` contains at most one accumulated amount per currency. Different
currencies are never silently converted or summed.

`totals` contains usage attributed to library operations. `unallocatedUsage` contains
model usage a stronger collector observed but could not safely assign to one. The two
are never silently merged. In particular, late background work must not be charged to
the next queued operation. ACP-derived metering cannot see hidden inference calls, so an
empty `unallocatedUsage` under ACP is not evidence that none occurred.

The session retains only totals, the active baseline, current context/provider cost, and
the last operation. It returns and emits every immutable operation record but does not
append them to an in-memory history array. Live library memory is therefore bounded with
respect to operation count.

Every `knownTokens` value is a lower bound, never an assertion that absent counters were
zero. Coverage is tracked per category because a harness may report input/output while
omitting cached-write or thought counters:

- `not_applicable` means every reached-provider operation was explicitly known not to use
  the category.
- `complete` means every applicable operation supplied an attributable value and no
  operation has unknown/unavailable coverage. It may coexist with some explicitly
  not-applicable operations after model/provider changes.
- `partial` means at least one operation supplied an attributable value and at least one
  applicable/unknown operation did not.
- `none` means no operation supplied an attributable value and applicability was not
  established as wholly `not_applicable`.

An explicit reported zero increments `attributedOperationCount`; it is different from an
absent counter. Category applicability comes from the frozen pricing policy or stronger
certified provider metadata, never from the mere absence of a price. The top-level
aggregate uses the narrower `AggregateUsageTotal`: total usage is always applicable, so
it has neither `notApplicableOperationCount` nor `coverage: "not_applicable"`. The
top-level operation counters remain useful for whole-record summaries but are not a
substitute for category coverage.

### Consumer-owned durability

Configuration accepts prior state:

```ts
export interface MeteringConfig {
  readonly enforcement?: MeteringEnforcement;
  readonly pricing?: PricingConfiguration;
  readonly initialState?: AgentSessionMeteringState;
}
```

`AgentSessionConfig.metering` is optional. Omission selects best-effort enforcement with
the pinned catalog resolver and no restored state. Context and usage observation remain
enabled, and every reached-provider operation still produces a record; metering is not
something a consumer must turn on merely to see protocol facts.

The consumer stores `record` and `record.nextState`, preferably atomically, and supplies
the last state when it reconstructs the stable session. Neither transcripts nor
`SessionManager` are required.

`initialState.version` is validated before reading any version-specific field. An
unknown version is a preflight error in `telemetry_required` and `billing_required`.
Best-effort mode ignores the foreign state as a whole, starts without its baseline or
totals, and exposes an explicit `initial_state_version_unsupported` unavailability reason
through `session.metering.restoration`. It must never partially read fields that happen to
resemble the current shape.

```ts
const initialState = await usageRepository.loadState(agentSessionId);
const session = await AgentSession.create({
  // ...
  metering: { enforcement: "telemetry_required", pricing, initialState },
});

const result = await session.prompt(text);
await usageRepository.commit(result.metering, result.metering.nextState);
```

The library is operatively stateful while the object lives but owns no mandatory durable
accounting database. If the consumer does not restore state, logical lifetime totals
cannot span process/object lifetimes.

---

## 12. Enforcement

```ts
export type MeteringEnforcement =
  | "best_effort"
  | "telemetry_required"
  | "billing_required";
```

This setting describes evidence policy, not authentication type. There is no
`subscription` mode and no subscription inference. `required` is not retained as an
ambiguous alias: callers must choose whether they require ACP telemetry or a certified
billing path.

### Telemetry required

`telemetry_required` is strict handling of ACP-derived telemetry. It is useful for tests,
diagnostics, and consumers that prefer to stop rather than accumulate gaps. It is not a
billing-grade guarantee:

- A loaded/resumed internal session requires a matching restored baseline.
- The selected pricing resolver must return a valid policy before sending.
- Known preflight failures reject before provider work begins.
- Missing or malformed post-operation usage does not discard an otherwise successful
  model response and does not reject it, because retrying could duplicate work and cost.
- Instead, the returned/emitted record is unavailable, the session becomes
  metering-blocked, and future token-consuming operations reject before sending.
- A blocked session can be recovered by the audited `reconcileMetering()` API below or by
  stopping and reopening it with reconciled state. There is no unrecorded in-place
  “assume zero” reset.
- Degraded PTY mode cannot satisfy telemetry-required structured metering and is rejected
  as a preflight configuration.
- A cumulative counter reset is a post-operation metering failure and blocks
  telemetry-required mode just like a missing/malformed report.
- If a reported optional token category has no applicable unit price,
  telemetry-required mode records the post-operation pricing failure and becomes blocked
  rather than silently excluding that category from cost.
- No unavailable value is converted to zero.

Telemetry-required mode cannot undo a provider operation that consumed tokens and then
omitted its usage. It detects the failure, preserves the response, and prevents continued
silent under-accounting. Provider billing reconciliation remains the consumer's
responsibility.

ACP currently advertises no usage capability and provides no prompt-free usage request.
Consequently, the library can fail fast on known conditions—degraded mode, missing load
baseline, model, or pricing—but cannot prove that a harness will return prompt usage
before the first provider operation. The first operation is necessarily the runtime
probe. It must never be presented as suitable for charging an end user.

### Billing required

`billing_required` is accepted only when an integration registered by the library
supplies a recognized certification and satisfies all of that certification's runtime
checks. The initial definition is in
`9-6-SPEC-opencode-certified-metering.md`. Plain ACP usage, a consumer-provided
provenance object, a model name match, or the mere presence of a catalog price can never
activate this mode.

An unsupported adapter, OpenCode version, provider route, runtime path, authentication
mode, plugin version, or incomplete price schedule is a preflight rejection. A loss of
measurement or attribution after work begins produces a durable incomplete record and
blocks later token-consuming operations without retrying the completed work.

### Audited reconciliation

```ts
export interface MeteringReconciliation {
  readonly state: AgentSessionMeteringState;
  readonly reason: string;
  /** Consumer/provider incident, invoice, or audit identifier. */
  readonly reference?: string;
}

export interface MeteringReconciliationResult {
  readonly before: AgentSessionMeteringState;
  /** New authoritative value for the next `initialState` restore. */
  readonly after: AgentSessionMeteringState;
}

const reconciled = await session.reconcileMetering(reconciliation);
await usageRepository.storeState(reconciled.after);
```

Reconciliation:

- Is allowed only while the session is idle with no queued operations.
- Requires a nonblank reason and a fully valid state matching the current
  `agentSessionId`, `adapterId`, and `internalSessionId`.
- Atomically replaces metering totals/baseline and clears `blocked` only after validation.
- Emits `metering_reconciled` containing immutable before/after states, reason, reference,
  and timestamp.
- Returns the same immutable before/after states. `after` is the new authoritative value
  for the consumer's `initialState` restore path and must be durably stored even when no
  later `metering_recorded` event occurs.
- Emits `metering_unblocked` after `metering_reconciled` when reconciliation transitions
  the session from blocked to unblocked.
- Does not invent an `OperationMeteringRecord` or claim that the adjustment was provider
  usage.
- Can be used in best-effort mode too, but is primarily the recovery mechanism for
  a strict mode.

The consumer remains responsible for durably storing both the reconciliation audit event
and its authoritative `after` state. A persistence integration must commit state changes
from `metering_reconciled` as well as `metering_recorded`; listening only to operation
records is insufficient.

### Best effort

Intended for user-owned logins/subscriptions and informational dashboards:

- Pricing is optional.
- Usage and context are recorded when available.
- Missing baselines or reports do not prevent later prompts.
- Tokens may be present with `pricing: null`.
- Provider-reported cost is displayed only with that provenance.
- No billing guarantee is made.

---

## 13. Provider-reported cost

ACP `usage_update.cost` is an optional cumulative provider-session value:

```ts
export interface ProviderCostSnapshot {
  readonly internalSessionId: string;
  readonly cumulative: Money;
  readonly observedAt: number;
}
```

It remains distinct from locally rated operation cost. The library must not name it
`actualCost` or assume it is an invoice: a subscription harness may report an
API-equivalent figure.

Provider cost is session state delivered independently of `PromptResponse`. The latest
observation is attached to an operation as `providerCostAfter`, but this first version
does not claim the observation was caused by that operation. A future empirically tested
revision may add attributable provider-cost deltas.

Like context, provider cost belongs to the active internal session and resets to `null`
on new/load/resume/handoff/provider-thread replacement before observations from the new
thread are accepted.

Update semantics preserve ACP's absent-versus-null distinction:

- An absent `cost` member leaves the previous `ProviderCostSnapshot` unchanged.
- An explicit `cost: null` clears it and emits `provider_cost_changed` with `null`.
- A valid cost replaces it and uses the notification observation time.
- Invalid cost data is ignored with a diagnostic and never clears a previously valid
  value implicitly. Provider cost is optional ACP telemetry, so malformed provider cost
  alone does not block strict token/pricing metering.

Public surface and notification:

```ts
session.providerCost: ProviderCostSnapshot | null;

{
  kind: "provider_cost_changed";
  providerCost: ProviderCostSnapshot | null;
}
```

Provider-reported and rated values in different currencies coexist as separate
facts. Core never converts, compares, or sums one into the other. Rated amounts aggregate
only with rated amounts of the same currency; provider observations remain cumulative
snapshots in their own reported currency.

---

## 14. Notification and ordering contract

Add session events:

```ts
| {
    kind: "context_window_changed";
    contextWindow: ContextWindowStatus | null;
  }
| {
    kind: "metering_recorded";
    record: OperationMeteringRecord;
  }
| {
    kind: "metering_blocked";
    reason: string;
  }
| {
    kind: "provider_cost_changed";
    providerCost: ProviderCostSnapshot | null;
  }
| {
    kind: "metering_reconciled";
    before: AgentSessionMeteringState;
    after: AgentSessionMeteringState;
    reason: string;
    reference?: string;
    reconciledAt: number;
  }
| {
    kind: "metering_unblocked";
    reason: "reconciled";
    metering: AgentSessionMeteringSnapshot;
  }
```

For a normal prompt:

```text
turn_started
...activity/context notifications...
metering_recorded
turn_completed
prompt promise resolves
```

`turn_completed.result.metering` is the same immutable logical record delivered by
`metering_recorded`; observers must not receive divergent calculations.

An operation with unavailable usage still emits `metering_recorded`. A strict mode then
emits `metering_blocked` before `turn_completed`.

Successful reconciliation first atomically installs the new state, then emits
`metering_reconciled`, followed by `metering_unblocked` if the prior state was blocked.
Both events observe the same new snapshot. Consumers can therefore observe the full
blocked/unblocked state machine without polling.

Listener exceptions remain observational and cannot change operation or metering state.

---

## 15. Timing semantics

`PromptResponse.usage` is the operation's cumulative token observation. Context and
provider cost arrive separately through `usage_update`, potentially before, during, or
after the prompt response.

The first implementation is deliberately conservative:

- It does not wait after a prompt response for a possible future update.
- `contextAfter` is the latest context snapshot observed before record completion.
- `providerCostAfter` is the latest cost snapshot observed before record completion.
- Neither field asserts that it includes the just-completed operation.
- Later `usage_update` notifications update live session state and emit notifications
  independently.
- Token attribution and local pricing use normalized `PromptResponse.usage`, not context
  occupancy.

Real-harness tests must investigate ordering before the contract is strengthened.

---

## 16. Cancellation, errors, and internal operations

Cancelled and failed prompts can consume tokens. Outcome and metering availability are
orthogonal:

```text
outcome=cancelled, usage.status=metered
outcome=completed, usage.status=usage_unavailable
```

Every operation that reached the provider produces a record even when no usage was
reported. A queued operation cancelled before it starts produces no token-consuming
metering record; its existing cancellation result remains sufficient.

Successful and cancelled prompts resolve with `AgentSessionPromptResult`. A prompt that
currently rejects because the controller/harness failed still has to make its metering
record available. Add a typed error rather than forcing direct callers to subscribe:

```ts
export class AgentSessionOperationError extends Error {
  readonly operationId: string;
  readonly metering: OperationMeteringRecord;
  readonly cause: unknown;
}
```

The same record is emitted through `metering_recorded` and attached to
`turn_failed`. Existing error text/cause must be preserved. This delivery can still say
`usage_unavailable`; the guarantee is that the operation is represented, not that the
harness supplied counters.

A failed handoff rejects with a corresponding typed handoff error carrying the ordered
`meteringRecords` produced before and during failure. Individual records are also emitted
as they complete. A rejected handoff therefore does not pretend to return a
`HandoffResult`.

Library-internal prompts must pass through the same metering primitive as user prompts.
Calling `controller.prompt()` directly from handoff without metering is not permitted
after this feature is implemented.

Configuration changes, authentication, listing, bridge entry, and process lifecycle do
not receive token records unless they issue an ACP prompt internally.

---

## 17. Performance and retention

Metering records contain no prompt, response, tool output, or attachment payload, but
their serialized size is not specified before implementation. The record now embeds
`nextState`, category coverage, unallocated state, pricing provenance, and up to five
priced categories; a guessed byte range is not an acceptance criterion.

Implementation must measure canonical JSON byte size for representative and maximum-shape
fixtures, publish the measured p50/p95/max fixture sizes in the implementation log, and
set a regression threshold from those measurements. Certified per-inference evidence is
measured separately because its size grows with physical inference count within an
operation.

Performance requirements:

- No unbounded operation array on `AgentSession`.
- No transcript scan during a prompt.
- Price resolution occurs once per rating unit: per queued operation for ACP-derived
  metering and per physical inference for a certified backend.
- Decimal calculation is proportional to the fixed number of token categories.
- Immutable snapshots may share immutable strings but never expose mutable internal
  objects.
- The consumer is responsible for pagination, retention, and aggregation of historical
  operation rows.

---

## 18. Transcript relationship

Metering works when both `transcriptPath` and `transcriptDir` are absent.

The operation record is not automatically treated as an authoritative transcript line.
Existing message transcript usage should be normalized for compatibility, but durable
metering is produced through return values/events and stored according to consumer
policy.

Conversation content and metering join through `operationId`; metering records do not
duplicate prompts or responses. This allows a consumer to delete/redact conversation
content while retaining permitted accounting data.

Transcript integrity is deferred and does not change these guarantees.

---

## 19. Failure and crash boundaries

The library cannot guarantee exactly-once financial recording across a process crash. If
a provider completes and charges an operation but the consumer process dies before it
stores the returned record, the provider may remain the only authoritative source.

The library provides stable operation ids and lifecycle notifications so a consumer may
create a pending row at `turn_started` and complete it at `metering_recorded`. Provider
billing reconciliation is required for invoice-grade recovery.

Consumers should enforce a unique constraint on `operationId` to make record delivery
idempotent.

---

## 20. Test plan

### Normalization

- Correctly normalize all ACP usage fields, including `totalTokens` and `cached*` names.
- Reject malformed required counters without coercing to zero.
- Preserve absent optional counters as absent.
- Pin the runtime object shape and public TypeScript type together.
- Stamp the cumulative interpretation in ACP-derived provenance.
- Never switch between cumulative and per-turn interpretations heuristically.

### Delta calculation

- New internal session uses a trusted zero baseline.
- Consecutive cumulative reports produce correct category deltas.
- Restored state produces the correct first post-reopen delta.
- Missing/mismatched restored state follows enforcement policy.
- Decreasing counters produce `counter_reset`, never negative usage.
- Optional counters appearing/disappearing do not fabricate deltas.
- Handoff resets the active internal baseline while retaining logical totals.

### Pricing

- Input/output/cache/thought categories use their own prices.
- Every priced category engraves reported tokens, priced tokens, unit price, and subtotal.
- Generate a deterministic catalog artifact from a pinned models.dev commit.
- Verify the generated artifact digest and canonical decimal conversion.
- Engrave pricing source, provider/model lookup keys, and selected tier.
- Refuse fuzzy model/provider fallback in strict modes.
- Treat missing catalog categories as unavailable rather than zero.
- Included-cache input subtracts cached-read/write deltas before pricing ordinary input.
- Excluded-cache input leaves ordinary input unchanged.
- The cache convention is engraved and invalid negative adjusted input is rejected.
- A changed resolver price affects only later records.
- A queued operation retains the price resolved for it.
- Model changes affect later records without mutating earlier records.
- Multiple currencies remain separate.
- Decimal multiplication uses scale 12 and round-half-even deterministically.
- Operation totals exactly sum the already-rounded engraved subtotals.
- Cross-operation rated totals exactly sum engraved operation totals without rerating or
  an additional rounding step.
- Provider JSON-number costs convert to canonical shortest round-trippable decimals.
- Provider cost and rated amounts in different currencies are never combined.
- Resolver `null`, throw, and rejection follow their specified enforcement paths.
- Best effort permits tokens with `pricing: null`.
- Strict-mode preflight rejects missing/invalid pricing before prompting.
- ACP-derived metering refuses a context-dependent tier because neither a cumulative
  delta nor `contextAfter` is a causal operation context-size fact.
- A backend missing any condition fact returns `pricing_unavailable` instead of using a
  proxy value or arbitrarily selecting a tier.
- Missing category prices do not imply `not_applicable`; applicability must be explicit.
- A reported token category contradicting `not_applicable` invalidates the policy/record.

### Context and provider cost

- `usage_update` populates a frozen context snapshot and derived fields.
- Context notifications fire on semantic change.
- Internal-session replacement resets context to `null`.
- Late updates from an old internal session are ignored.
- Provider cost remains cumulative and distinct from rated amounts.
- Absent provider cost preserves the last snapshot; explicit null clears it.
- Operation records label context/cost snapshots as observations, not causal deltas.

### Results, events, and enforcement

- Prompt results contain immutable operation records.
- Internal commands use `operationKind: "internal_command"`.
- Metering event precedes turn completion and promise resolution.
- Successful response plus missing usage returns the response and blocks strict modes.
- A blocked strict mode prevents later provider work.
- Counter reset blocks telemetry-required ACP metering.
- Valid idle reconciliation unblocks a strict mode and emits an audit event.
- Reconciliation emits `metering_reconciled` before `metering_unblocked`, with both
  observing the installed state.
- Busy, mismatched, or reasonless reconciliation is rejected without mutation.
- Best-effort mode continues after unavailable usage.
- Cancelled/error operations record reported usage when available.
- Work cancelled before provider execution produces no usage record.
- Listener failures do not affect metering or prompt results.

### Handoff

- Automatic handoff produces summary and seed records.
- Supplied-summary handoff produces only the seed record.
- Child operation ids are `${handoffId}:summary` and `${handoffId}:seed`.
- Records carry their actual old/new internal session ids.
- Both operations contribute to stable logical totals.
- Partial handoff failure preserves already-produced records.

### Persistence boundary and performance

- Metering works with transcripts disabled and without `SessionManager`.
- Restoring the returned `nextState` preserves lifetime totals.
- Reconcile, durably store `after`, stop before another operation, and reopen; restored
  totals and blocked state match the reconciliation.
- A persistence listener that handles both `metering_recorded` and
  `metering_reconciled` never silently restores pre-reconciliation state.
- Unknown future/foreign state versions fail preflight in strict modes.
- Best effort ignores an unknown state version wholesale and reports
  `initial_state_version_unsupported`.
- A mismatched `agentSessionId` is rejected/ignored according to policy.
- The live session retains only bounded metering state after many operations.
- Per-category totals expose complete/partial/none/not-applicable coverage and separate
  attributed, not-applicable, and unavailable operation counts.
- Aggregate `total` uses `AggregateUsageTotal`, cannot express not-applicable state, and
  tracks only attributed and unavailable operations.
- A non-reasoning/non-caching policy yields `not_applicable`, not an alarming missing
  category; mixed model histories retain complete coverage when every applicable
  operation was attributed.
- State version 2 keeps attributed and unallocated usage separate.
- Empty ACP unallocated state is not labeled proof of complete inference coverage.
- Canonical serialized record fixtures publish measured p50/p95/max sizes and enforce a
  measured regression threshold; certified inference arrays are measured separately.
- Consumer-side duplicate delivery can be deduplicated by operation id.

### Real-harness investigation

Run instrumented smoke tests against at least Codex ACP, Claude ACP, Pi ACP, Kimi ACP,
and OpenCode where available. Record:

- Whether prompt usage is present and whether the harness behaves cumulatively or
  per-turn despite ACP's contradictory documentation.
- Which optional token categories are populated.
- Whether input counters include cached-read and/or cached-write counters, with the
  evidence/source used for that conclusion.
- When model configuration becomes available.
- Ordering of final response versus `usage_update`.
- Whether context updates are sent after new/load/resume.
- Whether cost is provider-reported, locally rated, or omitted.
- Behavior on cancellation, errors, and compaction.

These observations may justify a later stronger timing/correlation contract. They do not
change the conservative first implementation.

---

## 21. Compatibility and migration

This pass changes more than one public contract and must be called out as such in release
notes:

- `Usage` becomes the normalized `TokenUsage` shape, adds required `totalTokens`, and
  corrects `cacheReadTokens` / `cacheWriteTokens` to `cachedReadTokens` /
  `cachedWriteTokens`.
- `PromptResult.usage` is interpreted as a cumulative internal-session observation by
  the ACP-derived backend, not guaranteed cumulative by ACP. Existing consumers that
  sum it must migrate to operation metering.
- `AgentSession.prompt()` and `executeInternalSessionCommand()` return the enriched
  `AgentSessionPromptResult`; lower-level `AcpClient.prompt()` continues returning
  `PromptResult`.
- Failed `AgentSession` operations reject with `AgentSessionOperationError` (and failed
  handoffs with the corresponding typed error) so metering survives rejection. Consumers
  relying on exact error identity or `instanceof` must inspect `cause`.
- Turn/handoff failure events gain metering data, and new metering/context/provider-cost
  events can be observed by exhaustive event switches.
- `HandoffResult` gains `meteringRecords` on success; failed handoffs expose records on
  the typed error and failure notification instead.
- Best-effort metering is the default and adds no mandatory durable storage or transcript
  writes.
- The ambiguous `required` name is replaced before implementation by
  `telemetry_required` and `billing_required`.
- Metering state begins at version 2 because pricing provenance and unallocated usage are
  part of the initial implemented persistence shape.

The release should include a short migration example showing old cumulative summation as
incorrect and `result.metering.usage.attributable` as the replacement.

---

## 22. Implementation sequence

1. Correct and test ACP usage normalization in `AcpClient`.
2. Add decimal money/unit-price utilities with focused tests.
3. Add the pinned models.dev generation pipeline, artifact digest, and default resolver.
4. Add context/model/provider-cost live state to `AgentSession`.
5. Add metering state restoration, delta calculation, provenance, and pricing resolution.
6. Add `AgentSessionPromptResult`, operation records, and notifications.
7. Route internal commands through the operation-kind-aware prompt path.
8. Route handoff summary/seed prompts through the metering primitive.
9. Add best-effort/telemetry-required enforcement and blocked-state behavior.
10. Extend the consumer smoke test with record persistence/restoration.
11. Run the real-harness timing matrix and document findings.
12. Implement billing-required support only through the separate certified OpenCode plan.

CLI presentation, quota parsing, transcript capture policy, and transcript integrity are
separate follow-up work.
