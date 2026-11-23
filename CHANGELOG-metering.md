# Metering — breaking changes and migration

Pre-1.0 changes introduced by the `AgentSession` metering feature
(`.res/somelogs.md/9-5+/9-6-SPEC-metering.md` §21). Fold this into the release notes.

## Native harness usage

- Agent-owned native turn metering is on by default (`best_effort`). A consumer-supplied
  `inferenceSource` and pricing policy are ignored. Measured usage has `native_ledger` provenance,
  unknown routing, partial attribution and no certification ID, even when every attempt was
  measured. Without provider or model identity, measured usage reports `pricing_unavailable`.
- `nativeUsage` carries observed call and attempt evidence. `usage.reason` explains partial
  measurement. Empty scans, an unavailable host, and undispatched turns with a metering record report
  unavailable usage.
  A prompt cancelled in the queue may have no metering record. Neither case establishes zero usage.
- A failed final save replays under its original operation ID if the write-ahead record was staged.
  If both writes fail, a later close can recover sealed calls as unaccounted usage of an earlier turn.
  The evidence is on that record in `nativeUsage.unaccountedEarlierCalls`, and its measured tokens
  accrue once to `state.unallocatedUsage`. These additions cover earlier-turn usage. Between-turn
  usage remains unsupported. `nativeUsage.earlierEvidencePending` flags earlier evidence still awaiting confirmation that its turn ended. Read attributed totals in `record.nextState.totals` or from the state returned
  by `persistence.metering.state(id)` for the conversation.
- SQLite schema 21 stores the per-channel cursor in metering state and bounded proof on the
  operation index row. The proof survives pruning of operation detail. The upgrade is one-way.
  Older code refuses a schema 21 database. If only truncated proof survives, later-sealed
  attempts outside the retained proof cannot be recovered as tokens and show as unmeasured.
  An already-counted attempt omitted from proof can also show as unmeasured in later evidence.
  That count cannot be summed as lost spend.
- Records written by the intermediate native metering implementation at `4bbefcb` are not backfilled.
- Native `billing_required` throws `MeteringPreflightError` until the harness can attest
  `native-harness@1` sealed per-turn accounting. Certification needs provider and model identity,
  normalized cache categories, reported cost and currency when available, attempt purpose, and a
  sealed turn manifest that can attest zero. Between-turn billing needs a harness producer for calls
  without turn ownership and bounded collection while idle.

## 1. `Usage` → `TokenUsage`, with corrected field names

The old type was wrong in three ways: it used non-ACP field names, omitted the required
`totalTokens`, and documented itself as per-turn.

```diff
-export interface Usage {
+export interface TokenUsage {
+  totalTokens: number;
   inputTokens: number;
   outputTokens: number;
-  cacheReadTokens?: number;
-  cacheWriteTokens?: number;
+  cachedReadTokens?: number;
+  cachedWriteTokens?: number;
   thoughtTokens?: number;
 }
```

`Usage` remains exported as a deprecated alias, so type-only consumers keep compiling.
Anything reading `usage.cacheReadTokens` gets `undefined` and must be renamed.

## 2. `PromptResult.usage` is a cumulative observation, not a per-turn amount

**This is the change most likely to produce silently wrong numbers.** The counters are
read as cumulative across the provider session, so summing successive reports
multiplies usage rather than accumulating it.

```ts
// WRONG — was already wrong, now demonstrably so.
let total = 0;
for (const result of results) total += result.usage?.inputTokens ?? 0;
```

```ts
// RIGHT — the library computes the per-operation delta for you.
const result = await session.prompt(text);
if (result.metering?.usage.status === "metered") {
  const used = result.metering.usage.attributable;   // this operation only
  const cost = used.ratedTotal;                      // engraved at the price in force
}
```

ACP does not actually guarantee cumulative: the SDK documents `PromptResponse.usage` as
usage "for this turn" while documenting the individual `Usage` fields as totals across
the session, and offers no discriminator. The library states the interpretation it
applied in `record.provenance.counterInterpretation` rather than pretending the protocol
settled it.

**Which reading applies is per-harness evidence, not a guess.** OpenCode was measured
reporting PER-TURN counters, so it is registered as such and its delta is the report
itself. Everything else defaults to cumulative until measured.
`MeteringConfig.counterInterpretation` overrides it for a harness version you know
differs.

`usage` is also `null` — never zero-filled — when a harness reports nothing or reports
something malformed. Null means unknown, not free.

## 3. `prompt()` and `executeInternalSessionCommand()` return `AgentSessionPromptResult`

A superset of `PromptResult`, so existing field access is unaffected. It adds
`operationId` and `metering`.

`metering` is `null` only for a prompt cancelled before it was dispatched — that
operation never reached the provider and consumed nothing, so no record is minted for it.

`AcpClient.prompt()` still returns the plain `PromptResult`.

## 4. Failed operations reject with typed errors carrying their records

```diff
 try {
   await session.prompt(text);
 } catch (err) {
-  console.error(err.message);
+  if (err instanceof AgentSessionOperationError) {
+    await usageRepository.commit(err.metering, err.metering.nextState);
+  }
+  console.error(err.message);   // preserved; original error is `err.cause`
 }
```

A failed operation can still have consumed tokens. `AgentSession.prompt()` rejects with
`AgentSessionOperationError` and `handoff()` with `AgentSessionHandoffError` (carrying
`meteringRecords`). Consumers matching on exact error identity must inspect `cause`.

## 5. New events on `AgentSessionEvent`

Exhaustive `switch` statements over the event union need new cases:
`context_window_changed`, `provider_cost_changed`, `metering_recorded`,
`metering_blocked`, `metering_unblocked`, `metering_reconciled`.

`handoff_failed` gains `meteringRecords`, and `HandoffResult` gains `meteringRecords`.

## 6. Pricing is on by default; opting out is explicit

Omitting `metering` selects best-effort enforcement with the pinned models.dev catalog.
It adds no durable storage and no transcript writes. A consumer that deliberately wants
no local rating sets `pricing: false` — which is distinct from rating that *failed*
(`pricingStatus: "pricing_unavailable"`).

Refresh the pinned catalog at release time with `bun run generate:pricing`.

## 7. Pricing sources carry two different dates

A record can now answer both "when did we capture these prices" and "how old is the price
itself" — different questions that a single timestamp conflates.

```ts
pricingCapturedAt(record.usage.attributable.pricingSource)
// pinned → generatedAt   live → fetchedAt   consumer override → null

record.usage.attributable.pricingKey.modelLastUpdated
// "2026-04-21" — when that model's entry last changed upstream
```

A catalog fetched a second ago can still carry a year-old rate, which is why the upstream
entry date is engraved beside the lookup key rather than inferred from the source.

`PricingSource` gains a third variant, `models.dev_live`, carrying `artifactSha256` and
`fetchedAt`. Exhaustive switches over the union need a new case. Live prices deliberately
do NOT use `kind: "models.dev"`: that shape promises an immutable upstream commit, and a
runtime fetch has verified none.

## 8. Records carry a provider-cost reconciliation

Every record gains `costReconciliation`, comparing the rated total against the rise in the
harness's own cumulative cost across that operation.

```ts
const check = record.costReconciliation;
if (check.status === "checked" && !check.matches) {
  // check.ratio === "2.032221" means the provider charged 2x what we accounted for
}
```

This exists because **ACP-derived metering undercounts any tool-using turn**. ACP reports
one model inference per prompt; a turn with N tool calls bills roughly N+1. Measured on
OpenCode: 1 tool call → 2.03x, 3 tool calls → 3.43x, 0 tool calls → 1.00x.

Do not bill from `attributable.ratedTotal` on the ACP backend. Bill from
`costReconciliation.providerDelta` where the harness reports cost, and treat the rated
total as the cross-check.

Agreement is judged on the ratio rounding to `1`, not on string equality: provider cost
arrives as a JSON float, so cumulative subtraction yields artifacts like
`0.002577469999999998` against an exact `0.00257747`.

## 9. `billing_required` needs a certified integration

The mode is refused unless the library has a certification registered for the adapter AND
a live `InferenceSource` presenting the matching `certificationId`. Neither a registry
entry alone nor a consumer-supplied flag opens it — certification describes evidence, not
configuration.

Only OpenCode qualifies today. For it:

```ts
const metering = await createOpencodeMetering();
const session = await AgentSession.create({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  env: metering.env,                                   // loads the plugin
  metering: {
    enforcement: "billing_required",
    inferenceSource: metering.inferenceSource,
  },
});
if (!(await metering.waitForPlugin())) throw new Error("metering plugin did not load");
```

The integration installs a plugin that observes one assistant message per model inference,
recovering the calls ACP hides. Verified against OpenCode's own database export: 9
inferences across 5 operations, cost and tokens matching exactly.

An unhealthy channel or zero observed inferences reports `usage_unavailable` and blocks in
`billing_required`, rather than falling back to a backend known to undercount.

**What blocks, and what only marks a record partial.** `billing_required` blocks on
PERMANENT loss — a report the channel refused for capacity, whose usage is accounted
nowhere. It does NOT block on an outstanding sequence gap: those usually resolve moments
later, and the late report then lands in `unallocatedUsage`, visible and costed. The
promise is "never silently under-account", not "every operation is perfectly attributed",
and halting a production session on a loopback reorder costs more than it prevents. Such
an operation still reports `attribution: "partial"`, and
`meteringSnapshot.outstandingReports` exposes the count so a consumer can alert on one
that stops falling.

A report arriving after its operation closed is routed to `unallocatedUsage` rather than
charged to whichever operation drains next — which is what makes not blocking defensible.

`routing` remains `"observed"` even here: the plugin reports what the harness ran, but a
library cannot prove no model call bypassed it.

## 10. Money totals carry their own completeness

`ratedTotal` and `ratedCosts` are no longer `Money | null` / `Money[]`. They are a
`MoneyTotal`:

```ts
interface MoneyTotal {
  readonly amounts: readonly Money[];   // one per currency
  readonly unaccounted: number;         // contributions that could not be included
}
```

```diff
-const cost = record.usage.attributable.ratedTotal?.amount;
+const cost = soleAmount(record.usage.attributable.ratedTotal)?.amount;
```

`soleAmount()` returns a figure only when exactly one currency is involved and nothing was
unaccounted; otherwise null, so the ambiguous case has to be handled rather than read as
`amounts[0]`.

Why this exists: `Money[]` had nowhere to record a contribution it failed to include, so
every accumulation site wrote `if (sum.ok) total = sum.value` and a failure silently became
a no-op. That single missing concept produced six separate under-reporting bugs — the worst
of which dropped an entire currency from an operation while reporting it fully priced.
Tokens never had the problem, because `UsageCategoryTotal` forces a coverage answer;
`addToTotal` now forces the same answer for money by returning a total rather than a
Result, so there is no `.ok` to forget.

`pricingStatus: "priced"` is now derived from the total being complete rather than from a
separate flag travelling beside it.

`unaccounted` counts contributions that were **attempted and failed**. Setting
`pricing: false` is a choice, not a failure, so a deliberately unrated session reports
`{ amounts: [], unaccounted: 0 }` — the same distinction `not_applicable` versus
`unavailable` draws for token categories. `pricingStatus` still separates the two
(`not_configured` versus `pricing_unavailable`).

`UnallocatedUsageState` loses its `costedRecordCount`/`uncostedRecordCount` counters —
`ratedCosts.unaccounted` says the same thing.

## 11. How an unrepresentable cost is reported

Nothing in the metering path turns an unknown cost into zero. Each place says so
differently, and the difference matters when reconciling against an invoice:

| where | what a consumer sees |
|---|---|
| a category could not be rated | `pricingStatus: "pricing_unavailable"` plus `pricingFailureReason` naming the category |
| one category of a priced operation | `PricedTokenAmount.pricing: null` with `reportedTokens` still present |
| a multi-model operation | top-level `pricing: null`; each rate lives in its own `lineItems` entry |
| the harness reported a malformed cost | the inference record is rejected outright; nothing partial is stored |
| the harness reported no cost | `ProviderInference.cost: null` — tokens are still recorded |
| any money total | `unaccounted` > 0 marks `amounts` as a **lower bound** |
| a total spanning currencies | `amounts` has several entries; `soleAmount()` returns null |
| provider cost vs our rating | `costReconciliation.status: "unavailable"` with a reason |

Nothing turns an unknown cost into zero, and no total can be read as complete without
saying so — `unaccounted` is on the total itself, so a lower bound cannot be mistaken for
a final figure.

## 12. Metering state starts at version 3

There is no version 1 or 2 on disk — nothing shipped before the MoneyTotal change, so
there is no migration to write. Restoration validates `version` before reading any
version-specific field; an unknown version is a preflight error in a strict mode and is
ignored wholesale in best-effort, surfaced through `session.meteringSnapshot.restoration`.

## Persisting and restoring

```ts
const initialState = await usageRepository.loadState(agentSessionId);
const session = await AgentSession.create({
  adapter,
  adapterId: "codex",
  agentSessionId,
  metering: { initialState },
});

const result = await session.prompt(text);
if (result.metering) {
  // Commit both together: a record stored without its state leaves the next session
  // with a stale baseline, which is how correct code still double-counts.
  await usageRepository.commit(result.metering, result.metering.nextState);
}
```

Enforce a unique constraint on `operationId` to make delivery idempotent. See
`smoke-tests/test6-metering/` for a runnable version of this contract.
