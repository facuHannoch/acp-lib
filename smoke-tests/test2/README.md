# test2 — live HTTP round-trip against a real agent

```bash
bun smoke-tests/test2/kimi-http-smoke.ts
```

Makes a real agent stand up a Python HTTP server, `curl` it, and report the status code.
The task is trivial on purpose; what makes it useful is that it cannot succeed unless a
tool call works end to end — write a file, run a command, and get the command's **output**
back. That is the surface where the interesting bugs live.

Unlike `bun test`, this talks to an actual agent over an actual pipe. It is not part of the
suite: it costs tokens, needs an authenticated CLI, and its timing depends on a model.

## Requirements

- `kimi` on `PATH`, authenticated (`ADAPTERS.kimi` → `kimi acp`)
- `python3` and `curl`
- a free TCP port (picked automatically by binding `:0` and releasing it)

## Options

| | |
|---|---|
| `--wire` | Also dump every raw protocol line to `chats/<stamp>.wire.jsonl` |
| `--wire=stderr` | The same, to the console (interleaves with the streamed reply) |
| `KIMI_SMOKE_TIMEOUT_MS` | Give up and interrupt after this long. Default 240000 |

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

Measured on real runs: **253 → 7** lines for two tool calls, **700 → 20** for six. Both
show exactly 3 lines per call (`announced → input → settled`).

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

## Files

`chats/` holds one transcript per run (`kimi-http-<stamp>.jsonl`), kept as format fixtures
the way `test1/chats` is.

`*.wire.jsonl` is **gitignored**: a wire log contains everything the agent said, file
contents and command output included, and runs to hundreds of kilobytes.
