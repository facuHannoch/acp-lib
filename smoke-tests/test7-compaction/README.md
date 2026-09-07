# test7 — compaction visibility

**Spends real tokens.** Needs a paid OpenCode route (`opencode auth login`, then a model
with credit).

```bash
bun smoke-tests/test7-compaction/compaction-smoke.ts
bun smoke-tests/test7-compaction/compaction-smoke.ts --model opencode-go/hy3 --reserved 200000
bun smoke-tests/test7-compaction/compaction-smoke.ts --natural --turns 25
```

Exit codes: `0` passed · `1` a check failed · `2` inconclusive (compaction never happened).

## The question

Compaction is the last known blind-spot candidate for the certified metering channel. It
is a model call **no user prompt asked for** — the harness issues it when context fills.
ACP never surfaces it. If the plugin misses it too, the integration has a smaller version
of the undercount that made ACP unusable for billing: invisible spend that still gets
charged.

Everything else has been measured. A tool-using turn reconciles exactly, and a five-turn
workflow matched OpenCode's own database on both cost and tokens. Compaction is the one
path not yet exercised.

## Why it verifies against `opencode export`

The check reads OpenCode's own session record from its database, not the channel under
test. Comparing the channel against `usage_update.cost` would be the library grading its
own homework — both numbers arrive over the same path that might be wrong.

## Two ways to trigger it

**Forced (default)** shrinks the usable context window via OpenCode's
`compaction.reserved`, a token buffer held back from the model's limit. Compaction fires
within a few turns for pennies instead of filling a 256k window.

The trade: it changes harness configuration, so it exercises OpenCode under an unusual
setting rather than the one a consumer meets.

**`--natural`** leaves compaction config alone and simply keeps talking until it fires.
Slower and more expensive, but it is the real behaviour. Prefer this if the forced result
looks surprising.

## If it stalls

A stalled turn is reported rather than hung (`--timeout-ms`, default 120s).

In forced mode a stall almost always means the window is **too small** — the harness
compacts repeatedly without making progress. Observed: `reserved: 250000` against a 256k
model leaves ~6k usable and never completes a turn.

The fix is counter-intuitive: **lower** `--reserved`, which leaves *more* usable context.
`200000` against a 256k model leaves ~56k, which is roomy enough to work while still
overflowing after a few file reads.

## Reading the result

- **`nothing left unattributed` FAIL is not necessarily a bug.** Compaction inferences
  landing outside an operation window is drain-based attribution correctly declining to
  charge an operation for work it did not request. Those belong in `unallocatedUsage`.
  What matters is that they are *seen* — the cost check is what proves that.
- **`cost matches` FAIL is the real failure.** It means the channel did not observe
  inferences OpenCode charged for, and the gap is the amount that would go unbilled.
- **INCONCLUSIVE proves nothing.** Compaction never happened, so the question is still
  open. Adjust `--reserved` or `--turns` and run again.
