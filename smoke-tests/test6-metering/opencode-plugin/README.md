# OpenCode metering plugin — reference probe

Evidence for the certified-integration path. Not production code: it is the smallest thing
that demonstrates the ACP-derived backend's blind spot and shows what closes it.

## The problem it demonstrates

ACP's `PromptResponse.usage` reports **one** model inference per prompt. A turn with tool
calls runs several, and the provider bills all of them. Measured on
`opencode-go/kimi-k2.6`, one tool-calling turn:

```
plugin: 2 assistant messages
  …nsIApcUigt   cost 0.00251802   tokens 8840
  …SFA5bqoqKL   cost 0.00239172   tokens 9118
  sum                0.00490974

ACP rated (last inference only)     0.00239172
provider's own cost for the turn    0.00490974   ← matches the plugin sum exactly
```

ACP saw the last inference and missed the first. The plugin saw both, and their costs sum
to the provider's own figure to the digit.

## How it works

Install into `.opencode/plugin/` (project) or `~/.config/opencode/plugin/` (global); files
there load at startup. The plugin subscribes to the `event` hook and keeps
`message.updated` events whose `info.role === "assistant"`.

Each assistant message **is one inference**, and carries everything metering needs, already
normalized by OpenCode across providers:

```ts
{ id, sessionID, providerID, modelID, summary,
  cost: number,
  tokens: { input, output, reasoning, cache: { read, write } } }
```

Three details that matter for a real implementation:

- **Dedupe by `messageID`.** `message.updated` fires repeatedly as a message streams — 12
  events for 2 inferences above. The final state is the one with `time.completed` set;
  earlier ones carry zeroed tokens and would sum to nonsense.
- **The categories are disjoint.** `input + output + reasoning + cache.read + cache.write`
  equals `tokens.total` exactly, matching what was measured through ACP. Cache is excluded
  from input and reasoning from output, so each can be priced without double-counting.
- **`providerID` is reported per message.** This is the structured provider evidence §7
  asks for, and it is what makes OpenCode priceable without splitting a model string on a
  convention.

`summary: true` marks a compaction message — an inference no user prompt asked for, which
is exactly the kind ACP hides.

## What this does not do

It does not attribute inferences to an `AgentSession` operation, handle plugin
disconnection, pin an OpenCode version, or fail closed when the channel drops. Those are
the substance of the certified integration, not of a probe.

Note the installed plugin API (`@opencode-ai/plugin` 1.18.10) has **no** `http.request` /
`http.response` hooks; those are v2. The `event` hook is sufficient and is available today.
