# test7 — compaction visibility

**Spends real tokens.** Needs a paid OpenCode route (`opencode auth login`, then a model
with credit).

```bash
# The one that answers the question today:
bun smoke-tests/test7-compaction/compaction-smoke.ts --stress-compaction 200000 --turns 2

# Normal operation (compaction will probably NOT fire — see below):
bun smoke-tests/test7-compaction/compaction-smoke.ts
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

## Getting compaction to happen is the hard part

Four approaches were measured. Only the last works on demand:

| approach | result |
|---|---|
| re-read one file each turn | context flat at ~25k/256k for 12 turns — OpenCode replaces the prior tool output rather than stacking it |
| a distinct file per turn | context grew ~255 tokens **per turn** despite 80KB reads; tool output is truncated and largely not retained |
| declare a smaller window (`provider.models.limit.context`) | context ran to 11,079 against a declared 11,000 with **no compaction** — this setting does not drive the decision |
| `compaction.reserved` (`--stress-compaction`) | compacts reliably, but in a runaway loop: turns never complete |

So `--stress-compaction` is the mode that answers the question, and it is deliberately
labelled pathological. Turns stall, attribution cannot succeed, and **only the capture
checks are meaningful** — which is fine, because capture is the question.

Without it the run will usually come back INCONCLUSIVE. That is honest: compaction did not
happen, so nothing was proven.

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
