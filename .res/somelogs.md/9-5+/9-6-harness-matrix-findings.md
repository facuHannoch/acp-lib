# Real-harness metering findings

Step 11 of `9-6-SPEC-metering.md` §22. Reproduce with:

```bash
bun smoke-tests/test6-metering/harness-matrix.ts            # free, no prompt sent
bun smoke-tests/test6-metering/harness-matrix.ts --prompt   # SPENDS TOKENS
```

Status: **connect-only pass complete. Prompting pass run against OpenCode only** (its
free tier costs nothing). Other harnesses' prompting pass not run — it consumes
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
