
## Part 9 — AgentSession metering specification

Status: specification complete; implementation pending.

### Purpose

Before implementing more CLI behavior, define the consumer-facing metering contract
needed by orchestration libraries. The design separates context-window pressure, token
usage, monetary estimates/provider cost, and non-standard subscription quota instead of
treating `/usage` output as one portable value.

The implementation-oriented specification is in `9-6-SPEC-metering.md`. Existing discussion
notes in `.res/somelogs.md/9-5+/9-5-metering.md` were preserved unchanged rather than
overwritten.

### Core boundary

Metering belongs to the stable `AgentSession` layer. `AcpClient` normalizes the ACP usage
payload but does not own pricing or logical-session aggregation. `AgentSession` maintains
bounded live state, calculates attributable deltas, applies the price resolved for each
operation, and returns/emits immutable operation records. The consumer owns the durable
history/dashboard and may pass the last versioned metering state back when reopening an
`AgentSession`.

Neither transcripts nor `SessionManager` become a required accounting database. Metering
works with transcripts disabled and without a catalog.

### Usage and context decisions

- ACP prompt counters are treated as cumulative internal-session observations rather
  than values that can be naively added after every turn.
- The public usage shape is corrected to include `totalTokens` and ACP's
  `cachedReadTokens` / `cachedWriteTokens` names.
- Attributable usage is calculated only from a trusted zero, a matching restored state,
  or a prior observation in the same live object.
- Missing values never become zero; decreasing counters are treated as resets rather
  than negative usage.
- Stable totals aggregate over `agentSessionId`, including handoffs and future provider
  changes.
- `session.contextWindow` represents only the latest active internal thread. It resets
  to unknown on a provider-thread transition and is replaced by later `usage_update`
  observations.

### Engraved pricing

Every attributable token category carries its token count, exact unit price, and computed
subtotal. Prices use an explicit denominator (normally one million tokens), currency, and
decimal-string amounts. Pricing is resolved before an operation and captured on that
queued operation, so a later global price change cannot alter historical records.

Input, output, cached-read, cached-write, and thought tokens can each have distinct unit
prices. `totalTokens` is not priced again because that would double-count its components.
Provider-reported cumulative cost remains distinct from locally estimated operation
cost and is never named actual/invoiced cost.

### Enforcement and subscriptions

The policy is `required` versus `best_effort`, not API versus subscription and not an
inferred login type.

- Required mode is intended for consumer-funded API access. Known missing baselines or
  pricing fail before provider work. Missing post-operation usage preserves the model
  response, emits an unavailable record, blocks further metered work, and never invites
  an automatic retry that could duplicate cost.
- Best-effort mode is intended for user-owned logins/subscriptions and informational
  dashboards. Usage may be present with no price, and missing telemetry does not block
  prompting.

Subscription quota and harness-specific `/usage` parsing are out of scope because ACP
does not standardize them and missing telemetry does not prove subscription use.

### Operation records and persistence

`AgentSession.prompt()` and internal-session commands are specified to return an enriched
result containing an immutable `OperationMeteringRecord`. The record contains operation,
logical/internal session, adapter/model, cumulative report, attributable/priced usage,
latest context/provider-cost observations, and `nextState`. It intentionally excludes
prompt, response, and tool content; consumers join those through `operationId`.

The live session retains totals, current baseline/context/provider cost, last operation,
and metered/unmetered operation counts—not an unbounded history. The consumer stores each
record and its next state and restores that state when reopening if lifetime totals and
first-operation deltas must remain exact.

Handoff summary generation and continuation seeding are separate metered operations.
Typed prompt/handoff errors must carry records for operations that reached the provider,
so rejected calls do not make accounting observable only through listeners.

### Timing and empirical work

Prompt token attribution uses normalized `PromptResponse.usage`. Context and provider
cost remain independently timed `usage_update` observations. An operation attaches only
the latest snapshot seen before it completes and does not claim that the snapshot
includes that operation. The library does not wait arbitrarily for a later notification.

The spec requires real-harness investigation across Codex, Claude, Pi, Kimi, and OpenCode
where available before this timing contract can be strengthened.

### Deferred work

- Runtime implementation and public exports.
- Real-provider timing/semantics measurements.
- Subscription quota parsing.
- CLI presentation.
- Transcript capture/security policy.
- Transcript hashing/HMAC integrity, since transcripts are not the accounting source of
  truth.

### Verification

- `9-6-SPEC-metering.md` contains 22 implementation-oriented sections covering scope, types,
  invariants, enforcement, event ordering, errors, performance, persistence boundaries,
  test cases, and implementation order.
- Markdown code fences are balanced.
- No trailing whitespace exists in the new specification.
- No runtime files or tests were changed in this part.

### Specification review corrections

A subsequent correctness review found seven areas that needed to be explicit before
implementation. The moved specification was revised in place.

#### Cache-inclusive input

`PricingSchedule` now requires a per-cache-category `cacheInputConvention`, recording
whether cached-read and cached-write counters are included in or excluded from the ACP
input counter. `AttributableUsage` engraves the convention, retains the unadjusted
cumulative-counter delta, and distinguishes `reportedTokens` from `pricedTokens` on each
line item. Included cache is subtracted before applying the ordinary-input price and then
priced in its own category; invalid negative adjusted input is never clamped to zero.

The real-harness matrix must record evidence for each adapter's convention, but the
immutable operation record remains the historical source for the assumption actually
used.

#### Partial category totals

`UsageTotals` no longer represents every category as an apparently complete number. Each
category exposes `knownTokens`, `unattributedOperationCount`, and
`complete | partial | none` coverage. Known totals are explicitly lower bounds. This
handles harnesses that report input/output but omit cached-write or thought counters
without fabricating category zeroes.

#### Decimal and currency semantics

The spec now fixes the accepted canonical decimal grammar, scale 12 calculation limit,
round-half-even behavior, per-category rounding, and exact summation of engraved rounded
subtotals. It defines conversion of ACP's JSON-number cost through the shortest
round-trippable JavaScript representation with exponent expansion, while acknowledging
that parse-time precision cannot be recovered.

One pricing schedule must use one currency. Provider-reported cost and local estimates in
different currencies remain separate and are never converted, compared, or summed by
core.

#### Required-mode recovery

ACP has no usage capability bit or prompt-free usage request, so required mode cannot
prove harness support before its first provider operation. It still fails fast on known
preflight defects. A later missing/malformed report or counter reset blocks subsequent
operations without discarding the already-produced model response.

Added an explicit `reconcileMetering()` design. It is idle-only, validates a complete
state against the current logical/adapter/internal identities, requires an audit reason,
atomically replaces state, and emits an immutable before/after reconciliation event. It
provides in-place recovery from a harness incident without an unaudited “assume zero”
escape hatch or mandatory process rebuild.

#### Edge behavior

- Pricing resolver absence, `null`, throw, and rejection now have defined required and
  best-effort behavior and never trigger automatic retries.
- Absent `usage_update.cost` preserves prior provider cost; explicit null clears it;
  malformed optional cost produces a diagnostic without blocking otherwise valid token
  metering.
- Provider cost was removed from `ContextWindowStatus` and exposed as independent live
  state because a cost-only change is not a new context observation.
- Handoff child operation ids are deterministically `${handoffId}:summary` and
  `${handoffId}:seed`.
- Counter reset is explicitly listed as a required-mode blocking failure.

#### Ownership and compatibility

The spec records the single-live-metering-owner assumption: two live logical sessions
loading the same internal provider thread can independently attribute the same cumulative
increments. ACP supplies no distributed lease, so exclusive ownership remains a consumer
registry/database responsibility.

A new compatibility section covers the complete migration surface: corrected `Usage` /
`TokenUsage` fields and cumulative semantics, enriched AgentSession prompt results, typed
operation and handoff errors, added event variants, and handoff result changes. Consumers
that previously summed `PromptResult.usage` must migrate to attributable operation usage.

## OpenCode certified-metering revision

The metering design was revised after establishing that ACP cannot negotiate usage
support and that its SDK documentation conflicts about per-turn versus cumulative prompt
usage. The former `required` design could stop after a missing report, but it could not
prove billing completeness before or after an operation. The specification no longer
presents strict ACP-derived telemetry as billing-grade evidence.

### ACP metering corrections

Revised `9-6-SPEC-metering.md` in place:

- ACP cumulative semantics are now an explicit library interpretation of contradictory
  SDK documentation, not a protocol fact. The interpretation is stamped in provenance,
  and the implementation may not switch semantics using an undocumented runtime
  heuristic.
- Added four evidence axes: source, measurement, routing, and attribution, plus an
  optional library-recognized certification id.
- Replaced the ambiguous enforcement name with `best_effort`,
  `telemetry_required`, and `billing_required`. ACP alone can satisfy only the first two;
  billing-required needs a certified integration.
- Renamed locally calculated monetary values from estimates to rated costs. A rated cost
  is exact under its engraved schedule while remaining distinct from provider-reported
  cost and an upstream invoice.
- Added a pinned models.dev snapshot as the default resolver. The immutable upstream
  commit, generated artifact SHA-256, generation time, provider/model lookup keys, tier,
  cache convention, unit prices, and subtotals are part of historical pricing evidence.
- The resolver freezes a complete versioned pricing policy before provider work, not
  necessarily one prematurely selected schedule. Context/service/batch-dependent tiers
  are selected afterward from trusted request/response facts without fetching new prices.
- ACP-derived metering resolves once per operation; certified OpenCode resolves once per
  physical inference. The plugin's two-phase start/finish protocol waits for pricing
  admission before each provider dispatch, so hidden auxiliary calls cannot bypass price
  preflight merely because the outer operation selected a different model.
- Retained consumer pricing overrides with mandatory stable version identity and added
  `pricing: false` as the explicit way to disable local rating.
- Required structured provider identity for default catalog lookup. The resolver does
  not guess a provider from an arbitrary model string.
- Recorded that OpenCode token normalization and models.dev pricing remain independently
  testable inputs even though they are maintained in the same ecosystem.
- Added explicit unallocated usage to version 2 of live/restorable metering state. ACP's
  inability to see hidden inference means an empty ACP unallocated bucket is not evidence
  of complete inference coverage.
- Updated compatibility, test, and implementation sections for the revised terminology,
  catalog generator, provenance, and state shape.

### New OpenCode specification

Added `9-6-SPEC-opencode-certified-metering.md` as the separate billing-required design.
It defines:

- A generic `openCode()` ACP adapter that remains best-effort and an explicit
  `managedOpenCode()` integration for certified operation.
- A load-bearing certification tuple covering exact OpenCode/plugin artifacts, runtime
  path, provider package, protocol, authentication mode, pricing snapshot, and tested
  model allowlist.
- An isolated managed OpenCode profile and an authenticated, versioned plugin handshake.
- A metadata-only local side channel carrying one record per physical model attempt,
  including retries and OpenCode's primary/compaction/title/generate classification.
- Source-inspection requirements proving that the pinned hooks cover every admitted
  model-call path; the resulting provenance is `routing: observed`, not an unsupported
  OS-level enforcement claim.
- Operation attribution using OpenCode session and parent-session identity rather than
  wall-clock windows alone, with auxiliary purposes and a durable unallocated path.
- Per-inference provider-normalized usage with no ACP cumulative baseline arithmetic.
- Catalog-based rating, certified overrides for price shapes models.dev cannot express,
  and fail-closed behavior for missing identity, category prices, or pricing tiers.
- Billing-required preflight/post-operation blocking conditions, reconciliation
  boundaries, security/privacy constraints, provider certification lifecycle, and a
  detailed fixture/live test plan.
- The first proposed slice: one pinned OpenCode build, its AI SDK path, one pinned
  Anthropic provider package, the Anthropic Messages protocol, API-key authentication,
  and an explicit model allowlist.
- The provider/credential gateway as a separate deferred subsystem rather than part of
  the first metering implementation.

### Important boundary found while writing

A single OpenCode adapter does not certify all OpenCode providers. Certification is per
precise execution route, and an OpenCode or provider-package update begins as
experimental even if an older tuple was certified. The OpenCode plugin API/runtime must
first be spiked against an actual released `opencode acp` build; missing identity or
lifecycle data must lead to a narrower certification or a pinned integration patch, not
guessed metadata.

### Verification

- Both specification files have balanced Markdown code fences.
- `git diff --check` reports no whitespace errors in tracked changes.
- The new specification contains no prompt, response, tool, or credential persistence in
  its side-channel contract.
- No runtime source, dependency, generated catalog, or test was changed in this part.

## Second metering-spec consistency review

A follow-up review identified seven internal consistency and persistence issues. Both
specifications were corrected before implementation.

### Reconciliation durability and recovery events

`reconcileMetering()` now returns immutable `before` and `after` states. The returned and
`metering_reconciled.after` value is explicitly the authoritative state for the next
`initialState` restore and must be persisted even when no later operation occurs. A
consumer persistence integration must process both `metering_recorded` and
`metering_reconciled`; operation records alone are insufficient.

Added `metering_unblocked`, emitted after `metering_reconciled` when the installed state
transitions from blocked to unblocked. Both events observe the same already-installed
snapshot. The test plan now includes reconcile, persist, stop before another operation,
and reopen.

### Pricing facts and tier selection

A pricing condition can now be evaluated only from a billing fact guaranteed by the
active backend. ACP cumulative deltas and `contextAfter` are explicitly forbidden as
proxies for operation context size. An ACP route unable to provide the fact required by
`context_tokens_at_least` returns `pricing_unavailable`, preserving the timing contract
and preventing accidental Anthropic long-context mispricing.

### State-version handling

`initialState.version` is validated before any version-specific field. Unknown versions
fail preflight in telemetry-required/billing-required modes. Best effort ignores the
foreign state wholesale and exposes structured restoration status with
`initial_state_version_unsupported`; it never reads coincidentally compatible fields.

### Category applicability and coverage

Pricing policies now declare each token category as applicable, not applicable, or
unknown independently from the presence of a price. A missing models.dev price does not
prove a category is inapplicable. Reporting a category declared not applicable is
contradictory evidence and invalidates the policy/record.

`UsageCategoryTotal` now distinguishes attributed, explicitly not-applicable, and
unavailable operation counts. Coverage adds `not_applicable`; mixed model histories can
remain complete when every applicable operation was attributed. Explicit reported zero
still counts as attributed rather than absent.

### Backend-neutral provenance

The shared provenance source changed from the harness-specific `opencode_plugin` to
`certified`. `certificationId` identifies the concrete OpenCode integration, allowing a
future certified backend without changing the core enum.

### Stale wording and accumulation

Corrected telemetry-required preflight from a pricing schedule to a pricing policy and
corrected the performance rule from once per queued operation to once per rating unit.
Cross-operation rated totals are now defined as exact same-currency sums of already
rounded engraved operation totals, with no rerating or second rounding step.

### Serialized-size requirement

Removed the inherited unmeasured “hundreds of bytes to a few kilobytes” claim. The
implementation must measure canonical JSON p50/p95/max fixture sizes, publish them in the
implementation log, and set a regression threshold from evidence. Certified
per-inference arrays are measured separately because their size varies with inference
count.

### Added verification cases

The test plan now covers unsupported state versions, reconciliation persistence across
reopen, unblock event ordering, unavailable ACP tier facts, explicit applicability,
not-applicable/mixed category histories, cross-operation decimal accumulation, and
measured serialized record sizes.

### Aggregate total type correction

A final type review noted that `UsageTotals.total: UsageCategoryTotal` allowed impossible
aggregate states: total tokens cannot be inapplicable, yet the shared category type
exposed `notApplicableOperationCount` and `coverage: "not_applicable"`. Added the narrower
`AggregateUsageTotal` for `UsageTotals.total`; it tracks known tokens plus attributed and
unavailable operations with only complete/partial/none coverage. Category totals retain
the richer applicability shape. The test plan now pins the impossible states out of the
public type.
