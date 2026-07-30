Yes — per agent, and it's a real gap in ACP: the spec standardizes the **output** (`agent_thought_chunk`) but says nothing about the **switch**. Each agent invents its own, so a harness has to decide this per adapter.

|        | how thinking is enabled                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| Codex  | on by default — streamed 8 chunks with no configuration; verbosity is its own `model_reasoning_effort` config |
| Kimi   | on by default — 4 blocks in the 13:21 run                                                                     |
| Claude | **off** unless `MAX_THINKING_TOKENS` is set                                                                   |

## How `MAX_THINKING_TOKENS` works

It's not an ACP field and not a Claude Code CLI flag — it's an environment variable of the **bridge process**, read by `claude-code-acp` at `session/new`:

```js
const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
  ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
  : undefined;
const options = {
  systemPrompt, settingSources: [...], stderr: ...,
  ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
  ...userProvidedOptions,
};
```

Four consequences worth knowing:

- **It's a budget, not a boolean.** The number is the token allowance for extended thinking, handed to the Claude Agent SDK. Unset → the option is never passed → no extended thinking → zero thought chunks. The underlying API wants at least 1024.
- **Read at session creation, not per prompt.** It applies to every session on that spawned process; changing it means respawning the agent.
- **`parseInt` isn't validated** — a non-numeric value yields `NaN`, which still passes the `!== undefined` guard and gets forwarded. Set a plain integer.
- **`_meta.claudeCode.options` overrides it**, spread last — that's the per-session route, but our client sends no `_meta` on `session/new`, so env is the only lever through this library today.

## What you set in your harness

No library change needed — `env` already flows `AgentSession` → controller → transport, merged over `process.env`. Verified just now with `MAX_THINKING_TOKENS` unset in the shell and passed only via config:

```ts
const session = await AgentSession.create({
  adapter: ADAPTERS.claude,
  adapterId: "claude",
  env: { MAX_THINKING_TOKENS: "4000" },   // Claude only; Codex and Kimi need nothing
});
```

```
thought chunks in : 2
visible updates   : 2   <- streamed
blocks            : 1
```

I'd put it in your per-agent adapter config rather than the process environment — it costs tokens on every turn, so it should be a deliberate per-agent choice. I deliberately did **not** add it to `ADAPTERS`: those presets carry only how to *launch* a binary, and baking in a thinking budget would spend a user's tokens by default.




---



Yes — real compute, not a display setting. But checking the docs turned up a correction to what I told you.

**It's actual inference work.** Thinking tokens are generated tokens: the model produces a separate reasoning pass before its answer, and those tokens are billed as output tokens. Turning it on changes the answer, the latency, and the bill — not just what you can see. That's why `MAX_THINKING_TOKENS` is a per-agent cost decision rather than a UI preference.

**It's a ceiling, not a quota.** The model spends what the task needs up to the limit and stops; a bigger number doesn't force more thinking on an easy question. And on the legacy parameterization the budget lives *inside* `max_tokens` — thinking plus answer share one output cap, so a too-tight `max_tokens` truncates the answer after the thinking is spent.

**Correcting my "at least 1024":** that minimum belongs to the older `thinking: {type: "enabled", budget_tokens: N}` API, where the budget was required and had to be ≥1024 and less than `max_tokens`. On current models that parameter is **removed** — it returns a 400 on Opus 5, Sonnet 5, Opus 4.7/4.8 and Fable 5, and is deprecated on the 4.6 family. The replacement is adaptive thinking, where the model decides depth itself, with `output_config.effort` (`low`→`max`) as the coarse dial. So don't read 1024 as a floor you must clear.

**One thing I can't determine from outside**, and it's worth knowing before you tune the number. On current models there are two independent axes:

- **whether the model thinks** — adaptive/effort, real tokens, real cost;
- **whether the reasoning is returned to the client** — `thinking.display`, which defaults to `"omitted"` on Opus 4.7+ and Sonnet 5. With that default the model still thinks and is still billed; the thinking blocks just arrive with empty text.

Our two zero-thinking Claude runs are consistent with either: extended thinking genuinely off, or thinking happening with its content withheld. All I verified is that setting `MAX_THINKING_TOKENS` made `agent_thought_chunk` appear. If it's the second, some of the cost was already being paid on those runs and you were just blind to it — which argues for setting the variable deliberately per agent rather than leaving it unset and assuming "no thinking, no cost."

Nothing changes in acp-lib either way: `env` on `AgentSession` is the lever, and the fold streams whatever arrives.