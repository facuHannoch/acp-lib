# Real-harness metering findings

Step 11 of `9-6-SPEC-metering.md` §22. Reproduce with:

```bash
bun smoke-tests/test6-metering/harness-matrix.ts            # free, no prompt sent
bun smoke-tests/test6-metering/harness-matrix.ts --prompt   # SPENDS TOKENS
```

Status: **connect-only pass complete. The prompting pass has not been run** — it consumes
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

## Finding 2 — `claude-code-acp` advertises no config options at all

Its `configOptions` map is empty, so `session.model` is `null`.

Consequence: the default catalog resolver returns `null` for this adapter, every record
is `pricingStatus: "pricing_unavailable"`, and `telemetry_required` fails preflight. The
one adapter with a provider mapping *and* full Anthropic catalog coverage cannot be
priced, because the model is unknowable through ACP.

This is the concrete shape of §7's `model: string | null` problem. It is not a bug to fix
in the library — inventing a default model would misprice every record — but it means
Anthropic pricing needs either the model supplied out of band by the consumer, or the
certified OpenCode route. Worth re-testing against `@agentclientprotocol/claude-agent-acp`
(the current package; only the deprecated `claude-code-acp` bridge is installed here).

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

## Still unanswered — needs the prompting pass

The question the whole ACP-derived backend rests on is **cumulative versus per-turn**, and
it cannot be answered without sending at least two prompts per harness. The probe sends
two and compares `totalTokens`; a non-increasing second report means the harness
implements the property doc's "for this turn" reading, and the delta algorithm must not
be applied to it (§4).

Also pending on that pass: which optional categories each harness populates, whether
`inputTokens` includes cached reads, whether cost is reported, and behaviour on
cancellation and compaction.

Until it runs, `counterInterpretation: "cumulative"` in provenance records an
*interpretation the library applied*, not a property any harness has been observed to
have. That is exactly what §4 says it is — but it is worth being blunt that no installed
harness has yet confirmed it.
