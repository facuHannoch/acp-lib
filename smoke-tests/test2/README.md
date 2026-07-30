# test2 — live HTTP round-trip against a real agent

```bash
bun smoke-tests/test2/http-smoke.ts          # default: kimi
bun smoke-tests/test2/http-smoke.ts claude
bun smoke-tests/test2/http-smoke.ts codex --wire
```

Makes a real agent stand up a Python HTTP server, `curl` it, and report the status code.
The task is trivial on purpose; what makes it useful is that it cannot succeed unless a
tool call works end to end — write a file, run a command, and get the command's **output**
back. That is the surface where the interesting bugs live.

Unlike `bun test`, this talks to an actual agent over an actual pipe. It is not part of the
suite: it costs tokens, needs an authenticated CLI, and its timing depends on a model.

## Choosing the agent

Any key of `ADAPTERS` — `kimi`, `claude`, `codex`, `gemini`, `copilot`, `opencode` — as the
first argument, `--agent=NAME`, or `SMOKE_AGENT`. Nothing in the script is agent-specific.

Swapping agents is also the diagnostic. Every check here is about **our** stream, so when a
run fails the first question is whether the library broke or the agent did — and the fastest
answer is the same task against a different one. The script helps rather than making you
read a wall of red:

- the binary is checked with `Bun.which` **before** spawning, so a missing CLI says so
  instead of surfacing as a connect timeout;
- an agent that emits no activity and no text at all exits `2` / `SMOKE INCONCLUSIVE`
  rather than failing twelve checks for one reason that isn't ours;
- a session that fails to start prints the agent's last stderr lines — kept even without
  `--wire`, since a refusing agent usually explains itself there and nowhere else.

## Requirements

- the chosen agent's CLI on `PATH`, authenticated (e.g. `ADAPTERS.kimi` → `kimi acp`)
- `python3` and `curl`
- a free TCP port (picked automatically by binding `:0` and releasing it)

## Options

| | |
|---|---|
| `<agent>`, `--agent=NAME`, `SMOKE_AGENT` | Which adapter preset to run. Default `kimi` |
| `--wire` | Also dump every raw protocol line to `chats/<agent>-http-<stamp>.wire.jsonl` |
| `--wire=stderr` | The same, to the console (interleaves with the streamed reply) |
| `SMOKE_TIMEOUT_MS` | Give up and interrupt after this long. Default 240000 (`KIMI_SMOKE_TIMEOUT_MS` still honoured) |

Exit codes: `0` all checks passed, `1` a check failed, `2` could not run — unknown agent,
missing binary, or an agent that produced nothing.

## What it checks

The pass condition is that **our** stream carried the evidence, not that the agent phrased
its answer well. `200` in the reply proves nothing — a model can say that without running
anything — so the load-bearing check is that a tool call's *output* contained it.

| Check | What breaks it |
|---|---|
| a tool call carried the 200 status in its output | tool output not reaching the caller — the bug where a tool block rendered as `{}` |
| `server.py` was written to our cwd | work happening somewhere other than where we pointed it |
| every tool call reached a terminal status | calls that never settle |
| the live fold and the transcript fold agree | fold drift, the risk the one-aggregator design exists to remove |
| the transcript folded the delta stream down | volume regression — a line per notification instead of per lifecycle step |
| each tool call cost at most 3 lines | the same, stated as a hard bound |
| every activity line is foldable | a line without `recordId`/`reason`, which no reader can fold |
| activity stayed inside the turn's msg fences | broken turn grouping — readers group by `msg(user) → activity… → msg(assistant)` |
| the snapshot is idle after the turn | the between-turns replay contract |
| the reply is a real sentence | a reply so short that "answered" and "said nothing" look identical |
| the transcript kept the assistant reply | the persisted reply drifting from what streamed |
| thinking was visible while it streamed | the opening chunk of a block going out as a delta, which `foldFrame` drops for want of a base — the block then appears only when it *closes*, so final state looks perfect and nothing streams |
| each thinking block cost one line | thinking persisted per chunk instead of per block |
| the live and persisted thinking agree | fold drift, on the one kind that crosses incrementally |

The three thinking checks only run when the model actually thought — that is its choice, not
ours. When it doesn't, the report says so explicitly rather than passing them silently.

Absent thinking usually means it is switched off, not unsupported. `claude-code-acp` maps
Claude's `thinking`/`thinking_delta` blocks to `agent_thought_chunk`, but only enables
extended thinking when `MAX_THINKING_TOKENS` is set in its environment:

```bash
MAX_THINKING_TOKENS=4000 env -u CLAUDECODE bun smoke-tests/test2/http-smoke.ts claude
```

It also **reports without asserting**: which transport the agent used (our `terminal/*`
handlers or its own execution), how many permission requests it made, and which record
kinds the `kinds` filter kept out of the transcript. Those are the agent's choices, not
library defects, so they are information rather than pass conditions.

Cleanup is best-effort but real: agents routinely forget to stop the server, so `killPort()`
reaps whatever is still listening via `lsof`.

## Reading the output

```
PASS  the transcript folded the delta stream down  — 700 raw events -> 20 lines (18 tool, 6 calls)
```

Measured on real runs: **253 → 7** lines for two tool calls, **700 → 20** for six (Kimi),
**32 → 15** for five (Codex). All show at most 3 lines per call
(`announced → input → settled`); Codex settles some calls in one step, so it lands under.

Agents differ in ways worth knowing before reading a number as a regression:

| | Kimi | Codex | Claude (`claude-code-acp`) |
|---|---|---|---|
| tool input | resent whole on every update (161 for one call) | terse | announced **twice**, placeholder then real |
| thinking | yes, no `messageId` → minted `think-1` | yes, `messageId` → `think-rs_…` | only with `MAX_THINKING_TOKENS` set |
| usage | yes | yes | none observed |
| tool transport | our `terminal/*` handlers | our `terminal/*` handlers | its own execution |

The fold absorbs all of it, and every one of those rows cost a code change or a test to
learn. Claude's double announcement is the sharpest: it arrives as two `tool_call`
notifications, not `tool_call` + `tool_call_update`, so the aggregator treats a re-announce
as an update — merging rather than replacing, and spending `input` rather than a second
`announced`. Measured before and after on the same task: `14 announced + 7 settled` became
`7 announced + 7 input + 7 settled`.

### `claude-code-acp` will not start inside Claude Code

```
err  Error: Claude Code cannot be launched inside another Claude Code session.
err  To bypass this check, unset the CLAUDECODE environment variable.
```

`session/new` fails with a bare `-32603 Internal error`; the reason is only on stderr. Run
`env -u CLAUDECODE bun smoke-tests/test2/http-smoke.ts claude`. The script keeps the agent's
last 25 stderr lines even without `--wire` and prints them on a start failure, because that
is the one place the answer lives.

`--wire` is the tool for "did the agent do that, or did we?". This one command usually
answers it:

```bash
jq -r 'select(.dir!="err") | (.line|fromjson) as $m
       | [.dir, ($m.method // (if $m.error then "error" else "result" end)),
          ($m.params.update.sessionUpdate // "")] | @tsv' chats/*.wire.jsonl | uniq -c
```

```
1 out  initialize
1 in   session/update            tool_call
161 in session/update            tool_call_update     ← one call, 161 resends
1 in   session/request_permission
1 in   fs/write_text_file
```

Two findings from actual runs, both invisible without it:

- Kimi resends the whole growing tool input on **every** update — 161, then 81, then 44
  updates for three calls. That is what the activity fold absorbs.
- A reply that read as `…properly.Curl printed…` looked like a concatenation bug on our
  side. The log showed Kimi sent `"."`, `"C"`, `"url"` as separate chunks: our
  concatenation is byte-faithful, the missing space is the agent's.

## What it found

Beyond the two wire-log findings above, the transcripts here surfaced a reader bug: `limit`
counted lines while `readTranscript` returns messages, so asking for 5 gave 1 of 2 messages.
Fixed with `types` on `ReadTranscriptOptions`; these files are the fixtures that showed it.

It also confirmed the thinking-stream fix against a live agent — Codex: 8 thought chunks,
8 visible updates. Under the bug, 4 (one per block, at close) was the ceiling.

And it settled an "is it us?" the fast way. Kimi accepted a prompt, sent its command list,
went silent for 243 s, then answered our `session/cancel` in 11 ms — the same wire log that
showed the silence showed the protocol layer was healthy throughout. The same task against
Codex passed 18/18 minutes later. Hence `SMOKE INCONCLUSIVE`: that run had nothing to say
about the library, and shouldn't have looked like it did.

## Files

`chats/` holds one transcript per run (`<agent>-http-<stamp>.jsonl`), kept as format
fixtures the way `test1/chats` is.

`*.wire.jsonl` is **gitignored**: a wire log contains everything the agent said, file
contents and command output included, and runs to hundreds of kilobytes.
