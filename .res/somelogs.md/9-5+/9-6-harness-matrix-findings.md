# Real-harness metering findings

Step 11 of `9-6-SPEC-metering.md` §22. Reproduce with:

```bash
bun smoke-tests/test6-metering/harness-matrix.ts            # free, no prompt sent
bun smoke-tests/test6-metering/harness-matrix.ts --prompt   # SPENDS TOKENS
```

Status: **connect-only pass complete. Prompting pass run against OpenCode**, on both the
free Zen tier and the paid Go plan. Other harnesses' prompting pass not run — it consumes
real tokens against whatever credentials each harness is configured with, which is the
operator's call, not the library's.

## Connect-only results

| adapter | installed | connected | providerId | model reported | context before prompt |
|---|---|---|---|---|---|
| kimi | yes | yes | — | `kimi-code/kimi-for-coding` | no |
| claude | no | — | — | — | — |
| claudeCode | yes | yes | `anthropic` | **none** | no |
| codex | yes | yes | `openai` | `gpt-5.6-terra` | no |
| pi | yes | yes | — | `openai-codex/gpt-5.5` | no |
| gemini | no | — | — | — | — |
| copilot | no | — | — | — | — |
| opencode | yes | yes | — | `opencode/big-pickle` | no |

## Finding 1 — no harness reports context before the first prompt

Every connected harness returned nothing for `usage_update` in the ~750 ms after
`session/new`. `session.contextWindow` is therefore `null` until a turn has run, on all
five installed harnesses.

This validates §5's conservative stance (`null` until the active thread reports) and
§15's refusal to wait for an update after a prompt response. Nothing here justifies
strengthening the timing contract.

## Finding 2 — CORRECTED: the current Claude bridge does advertise a model

The first pass reported that `claude-code-acp` advertises no config options. **That was
wrong, twice over.**

1. The probe ran inside a Claude Code session, so `CLAUDECODE` was set and the Claude CLI
   refused to launch: *"Claude Code cannot be launched inside another Claude Code
   session."* `session/new` failed with `-32603 Internal error`, and the empty config map
   was the consequence of a session that never existed. The probe now clears `CLAUDECODE`
   and only reports `connected` when a provider thread id actually exists.
2. Even with that fixed, the installed binary is `claude-code-acp` **0.16.2** — the
   deprecated bridge — which genuinely advertises nothing. The current package does not:

```
$ bunx @agentclientprotocol/claude-agent-acp
configOptions: mode="default"  model="opus"  effort="medium"  fast="off"
```

So the `claude` preset reports a model. The real gap is different and smaller:

**`opus` is a harness alias, not a models.dev key.** The catalog holds
`claude-opus-4-5`, `claude-opus-5`, and so on; `opus` matches none of them, so the
default resolver returns null and the operation stays unpriced. That is the correct
behaviour — resolving an alias to a concrete version is a guess, and guessing wrong
misprices every record — but it means Anthropic pricing needs an alias→model mapping
before it works end to end. That mapping is version-sensitive (today's `opus` is not
last quarter's) and belongs with the certified-integration work, or with a consumer
resolver that knows which version its account actually serves.

## Finding 3 — codex is the one adapter that prices end-to-end today

```
providerId  openai            (tested adapter mapping)
model       gpt-5.6-terra     (from the `model` config option)
catalog     matched, 2 schedules: default + context_over_272000
convention  cachedRead/cachedWrite included_in_input
60k input   $0.12
```

The long-context tier is present, which means §7's rule bites in practice: the
ACP-derived backend cannot supply a trusted context size, so any operation that would
need `context_over_272000` resolves to `pricing_unavailable` rather than being priced at
the wrong tier. Expected, and correct — but it means codex pricing is only available
below the tier boundary.

## Finding 4 — several harnesses report composite `provider/model` strings

`kimi-code/kimi-for-coding`, `openai-codex/gpt-5.5`, `opencode/big-pickle`.

These are not plain model ids and will never match a models.dev key. All three already
resolve to `providerId: null`, so they stay unpriced and no wrong number is produced.

The interesting part is that the string *encodes the provider*, which is close to the
structured evidence §7 asks for. It is deliberately not parsed today: the separator is a
convention, not a protocol guarantee, and a mis-split would produce a confident wrong
price. It is a reasonable input to the certified-integration work, where the harness
version is pinned and the format can be verified.

## Finding 5 — OpenCode reports PER-TURN counters, not cumulative

The most consequential result of the exercise, and it contradicts the interpretation the
library currently applies.

Three consecutive turns on `opencode/big-pickle`:

| turn | totalTokens | inputTokens | outputTokens | cachedReadTokens |
|---|---|---|---|---|
| 1 | 9996 | 5897 | 3 | 4096 |
| 2 | 10024 | 20 | 20 | 9984 |
| 3 | 10035 | 48 | 3 | 9984 |

`totalTokens` rises monotonically, so a naive check calls this cumulative — the first
version of this probe did exactly that. The components settle it:

```
5897 + 3 + 4096 = 9996   = totalTokens
  20 + 20 + 9984 = 10024  = totalTokens
  48 +  3 + 9984 = 10035  = totalTokens
```

Every report's `totalTokens` is the sum of *its own* components, so each report describes
one turn. The totals only appeared to grow because every turn re-reads the same ~10k of
cached context. `inputTokens` falling 5897 → 20 is the giveaway.

OpenCode therefore implements the SDK property doc's "for this turn" reading, which is
exactly the ambiguity §4 documents and refuses to resolve by heuristic.

### What the library currently does with it

Turn 1 is right by accident: from a trusted zero baseline, the delta equals the report,
which for a per-turn harness is the correct per-turn value. Turn 2 then produces
`counter_reset` (`inputTokens decreased from 5897 to 20`) and every later turn does too,
so nothing is attributed.

That is the design behaving as intended — it reported "I don't know" rather than
inventing a number — but it means **OpenCode is unmeterable through the ACP-derived
backend as specified**, which matters because OpenCode is the intended certified route.

### Bonus: the same identity answers the cache question

`totalTokens = input + output + cachedRead` exactly means `inputTokens` **excludes**
cached reads for this route: `cachedRead: "excluded_from_input"`. That is one of the two
conventions §7 requires and cannot infer.

### The decision this forces

§4 says a per-turn harness "must not use the cumulative delta algorithm; until a
separately tested interpreter exists, their ACP usage is unavailable for attribution."
Two ways forward:

1. **Implement a per-turn interpreter** — the delta *is* the report, so the arithmetic is
   trivial. The hard part is knowing which harnesses qualify, which must be adapter- and
   version-scoped evidence, never a runtime guess (§4 forbids switching interpretations
   mid-session).
2. **Mark OpenCode per-turn and leave its usage unavailable**, per the spec as written.

Option 1 is the only one that makes the intended certified route usable.

### Resolved — the per-turn interpreter is implemented

`counterInterpretationForAdapter()` records the evidence (OpenCode → `per_turn`,
everything else → `cumulative` until measured), `MeteringConfig.counterInterpretation`
lets a consumer override it for a version they know differs, and the interpretation is
stamped into every record's provenance. For a per-turn harness the delta *is* the report:
no baseline is needed, and no counter reset is possible, because a counter that
"decreased" only means this turn was smaller than the last.

Re-measured on `opencode/big-pickle` after the change:

```
metered  interp=per_turn  attributed=9998
metered  interp=per_turn  attributed=10009
metered  interp=per_turn  attributed=10020
totals: 30027 tokens, coverage=complete, metered=3/3
```

Previously: one attributed turn and two `counter_reset`s.

## Finding 6 — OpenCode normalizes counters into DISJOINT categories

Measured across four distinct underlying providers behind the Zen gateway (big-pickle,
Ling, MiMo, Nemotron), eight consecutive reports. Every single one satisfied:

```
totalTokens === inputTokens + outputTokens + cachedReadTokens + thoughtTokens
```

Disjoint terms settle both conventions §7 requires and cannot infer:

- **cache is excluded from input** — cached reads are their own term, so pricing input at
  the full reported figure does not double-charge them.
- **thought is excluded from output** — the gap §7 has no field for. For this route,
  pricing reasoning separately double-counts nothing.

Because the identity holds across four different upstream providers, the convention is a
property of OpenCode's own normalization rather than of the model behind it. That is what
makes one catalog entry legitimate for all 102 of its models.

## Finding 7 — the OpenCode route prices end to end

models.dev carries an `opencode` provider (102 models) with Zen's own prices, which
differ from the upstream provider's. OpenCode advertises models as
`opencode/<models.dev key>`, so the two halves are exactly the catalog lookup keys.

The split is adapter-scoped and validated, not a general heuristic. Other harnesses use
the same shape with a first segment that is not a catalog provider —
`openai-codex/gpt-5.5`, `kimi-code/kimi-for-coding` — and a first segment that merely
looked like a provider would price a proxied route at the upstream provider's rates.

Live result:

```
advertised=opencode/mimo-v2.5-free  provider=opencode  model=mimo-v2.5-free
status=priced  delta={total:9988, input:53, output:15, cachedRead:9920}  rated=0
```

Rated 0 because the model is free — models.dev prices it at zero, and the pipeline
carries that through honestly rather than treating a zero price as a missing one.

A model that reports a category the catalog cannot price stays unpriced, with the reason
recorded:

```
opencode/ling-3.0-flash-fin-free  →  pricing_unavailable
  "schedule default has no thought unit price"   (the harness reports thoughtTokens=18)
```

That is §7 behaving as designed: a reported category with no price makes rating
unavailable rather than being silently dropped from the total. It also surfaced a real
bug — the reason was computed and then discarded, so records said
`pricing_unavailable` with no way to find out why. Fixed.

## Finding 8 — rated cost reconciles EXACTLY with the provider's own cost

The strongest result available: on a live billed route the library's independently
computed cost equals what OpenCode itself reports, to the last digit.

Route: `opencode-go/kimi-k2.6` (the OpenCode Go plan; the Zen workspace has no balance,
so paid Zen models refuse). models.dev prices it input 0.95, output 4, cache_read 0.16
per 1M — and no `reasoning` entry at all.

| turn | our rated cost | provider cost delta | match |
|---|---|---|---|
| 1 | 0.00188837 | 0.00188837 | yes |
| 2 | 0.00184357 | 0.00184357 | yes |
| 3 | 0.00183077 | 0.00183077 | yes |

Session total `0.00556271` equals the provider's reported cumulative `0.00556271`.

That reconciliation simultaneously confirms four things that were previously assumptions:
per-turn counters, cache excluded from input, the delta arithmetic, and the decimal
rating path.

### It also settled the thought question

`kimi-k2.6` reports `thoughtTokens` while the catalog prices no reasoning category. Under
the original rule — a reported category with no price makes rating unavailable — the whole
route was unpriceable.

Pricing input/output/cache alone left a residual of exactly `0.00014` against a reported
35 thought tokens, i.e. **4.00 per 1M — that model's output rate to the digit**. Reasoning
is reported as a disjoint counter but billed as output.

This is the §7 gap flagged during implementation: there was a `cacheInputConvention` for
the input side and nothing for the output side. `ThoughtConvention` now fills it:

- `separate_price` (default) — use the schedule's own thought price, and refuse to rate
  when a reported thought category has none. Still the honest default.
- `billed_as_output` — apply the schedule's OUTPUT price, and engrave that price so the
  record shows which rate was actually applied.

Both live turns are pinned as regression tests against the measured figures.

### Provider cost is cumulative while token counters are per-turn

Worth noting because it is an easy trap: on the same route,
`usage_update.cost` rises monotonically (0.00348629 → 0.00533386) while `inputTokens`
falls (2475 → 443). §13 already treats provider cost as cumulative and §4 treats token
counters as an open question — this route is per-turn for tokens and cumulative for cost
at the same time.

## Finding 9 — tool calls break the reconciliation, by 2-3x

**The most important finding in this document, and it reverses Finding 8's optimism.**

Finding 8 reconciled exactly on three turns. Those turns had no tool calls. Repeating the
measurement on a turn that uses tools, in a scratch directory, on the same route:

| turn | tool calls | our rated cost | provider actual | captured |
|---|---|---|---|---|
| 1 | 3 | 0.00269497 | 0.00924448 | 29% |
| 2 | 1 | 0.00262617 | 0.00532939 | 49% |

Session: ours `0.00532114` against an actual `0.01457387` — **under-reporting by 2.7x**.

The ratios are the explanation. 0 tool calls → 1.00x, 1 tool call → 2.03x, 3 tool calls
→ 3.43x. ACP's `PromptResponse.usage` reports **one inference**; the provider bills
roughly **tool calls + 1**, because each tool result is another round trip that re-sends
the whole context. §1's "an ACP prompt may hide retries, compaction, or multiple model
calls" is not an edge case — for a coding agent it is the normal case.

### The dangerous part was the silence

The record said `pricingStatus: "priced"`, `unallocatedUsage.recordCount: 0`, and
`coverage: "complete"`. Nothing indicated a 3x gap. Provenance did carry
`attribution: "partial"`, which was technically honest and practically useless — no
consumer reads a qualitative enum and infers a factor of three.

### Mitigation: reconcile against the provider's own cost

Every record now carries `costReconciliation`, comparing the rated total against the rise
in the harness-reported cumulative cost across that operation. Provider cost is the only
visibility the ACP-derived backend has into inferences it never saw.

Measured after the change, same route:

```
"Reply with exactly: ok"                    status=checked matches=true  ratio=1
"Read a.txt and b.txt ... use your tools"   status=checked matches=false ratio=2.032221
```

A silent 3x under-count is now a loud, quantified one. It does not FIX the gap — the
tokens are still invisible — but it converts an undetectable billing error into a
detectable one, which is the difference between unusable and usable-with-a-guard.

### What this means for billing

Do not bill from `attributable.ratedTotal` on any harness that uses tools. Bill from
`costReconciliation.providerDelta` where the harness reports cost, and treat the rated
total as the cross-check. Where the harness reports no cost, ACP-derived metering cannot
support billing at all — only observability.

## Finding 10 — the certified OpenCode integration closes the gap

Finding 9 measured a 2-3x undercount on tool-using turns and added a reconciliation check
that could DETECT it. The plugin integration removes it.

Same route, same tool-calling prompt, `enforcement: "billing_required"` with a live
channel:

| turn | provenance | rated | provider | ratio |
|---|---|---|---|---|
| plain | certified/complete | 0.00182167 | 0.00182167 | 1 |
| **with tool calls** | certified/complete | 0.00472139 | 0.00472139 | **1** |

Session total `0.00654306` against a provider cumulative of `0.00654306`. The tool-calling
turn measured `ratio 2.51` through ACP an hour earlier; through the plugin it is exactly 1.

### How it is wired

- `createOpencodeMetering()` starts a loopback channel, writes a managed profile, and
  returns the env to merge plus an `InferenceSource`.
- The plugin ships as plain JS (OpenCode loads it, not us) and posts one record per
  completed assistant message.
- `OPENCODE_CONFIG` loads the plugin from an absolute path, so nothing is written into the
  consumer's repository. The managed config MERGES the user's own — it is a replacement
  env var, so a naive temp file would silently drop their model choice and providers.
- Attribution is drain-based: `AgentSession` serializes operations, so everything drained
  at the close of one belongs to it. Simpler and safer than timestamp windows, which would
  misattribute an inference completing as the next operation opens.

### What it deliberately does not claim

`routing` stays `"observed"`, never `"enforced"`. The plugin reports what the harness ran;
a library spawning a subprocess cannot prove no model call bypassed it. Network isolation
remains a deployment property.

### Failure behaviour

An unhealthy channel or zero observed inferences reports `usage_unavailable` rather than
falling back to ACP — falling back would silently resume undercounting, which is the exact
failure the path exists to prevent. In `billing_required` that blocks the session.

### Two fixes this surfaced

- A category reported as exactly **0** with no catalog price no longer refuses to rate.
  OpenCode reports `cache.write` on every inference, usually zero, and most catalog entries
  carry no cache-write price, so the strict rule blocked every operation. Zero tokens cost
  zero at any rate; a non-zero unpriced category still refuses.
- `billing_required` needs BOTH a registry entry and a live source presenting the matching
  `certificationId`. A registry entry alone would make the gate decorative.

## Still unanswered — needs the prompting pass on other harnesses

The question the whole ACP-derived backend rests on is **cumulative versus per-turn**, and
it cannot be answered without sending at least two prompts per harness. The probe sends
two and compares `totalTokens`; a non-increasing second report means the harness
implements the property doc's "for this turn" reading, and the delta algorithm must not
be applied to it (§4).

Also pending on that pass: which optional categories each harness populates, whether
`inputTokens` includes cached reads, whether cost is reported, and behaviour on
cancellation and compaction.

`counterInterpretation: "cumulative"` in provenance records an *interpretation the
library applied*. No installed harness has yet confirmed it, and the one harness actually
measured — OpenCode — contradicts it.
