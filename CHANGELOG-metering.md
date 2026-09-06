# Metering — breaking changes and migration

Pre-1.0 changes introduced by the `AgentSession` metering feature
(`.res/somelogs.md/9-5+/9-6-SPEC-metering.md` §21). Fold this into the release notes.

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

## 7. Metering state starts at version 2

There is no version 1 on disk — pricing provenance and unallocated usage are part of the
initial persisted shape. Restoration validates `version` before reading any
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
