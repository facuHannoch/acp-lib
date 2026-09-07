# test7 — compaction visibility

**Spends real tokens.** Needs a paid OpenCode route (`opencode auth login`, then a model
with credit).

```bash
bun smoke-tests/test7-compaction/compaction-smoke.ts
bun smoke-tests/test7-compaction/compaction-smoke.ts --fill-kb 200 --turns 20
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

## How compaction is triggered

Honestly: the harness's own settings are left alone, and context is filled with real file
reads until OpenCode decides to compact. `--fill-kb` sizes the file re-read each turn
(default 120KB), `--turns` caps how long it keeps going.

Cost is bounded by prompt caching. The same file is re-read every turn, so after the first
one it bills at the cache-read rate rather than the input rate.

### Why there is no "force compaction" flag

An earlier version forced it with OpenCode's `compaction.reserved`, assuming that setting
holds tokens back from the model's limit. **That reading was wrong**, and the run proved
it:

| run | expected | observed |
|---|---|---|
| `reserved: 200000` on a 256k model | ~56k usable, no compaction for several turns | 19 compactions in 120s, turn 1 never completed |
| no compaction config, same model | — | 10k/256k used, turns completed cleanly, ratio 1 |

Whatever `reserved` actually controls, forcing it produced a pathological compaction loop
rather than the behaviour under test. A test that changes harness configuration risks
measuring the change instead of the thing, so the knob is gone.

## If it stalls

A stalled turn is reported, not hung (`--timeout-ms`, default 120s). Try a smaller
`--fill-kb`, or a longer timeout on a slow model.

## Reading the result

**Capture and attribution are scored separately, and only one of them is the question.**

- **`channel saw every inference OpenCode charged for`** is the question. FAIL means the
  channel missed work that was billed, and the gap is what would go unbilled.
- **`attributed totals match`** can fail while capture passes. A stalled or interrupted
  turn never closes, so nothing is drained into it and the work stays unattributed — which
  is drain-based attribution correctly declining to charge an operation for work it did
  not complete.
- **`nothing left unattributed` FAIL is not necessarily a bug**, for the same reason.
  Those inferences belong in `unallocatedUsage`; what matters is that they were *seen*.

- **INCONCLUSIVE proves nothing.** Compaction never happened, so the question is still
  open. Raise `--turns` or `--fill-kb` and run again.

An earlier version collapsed capture and attribution, and scored a successful capture of
19 compaction inferences as a failure because a stalled turn meant nothing had been
attributed yet.
