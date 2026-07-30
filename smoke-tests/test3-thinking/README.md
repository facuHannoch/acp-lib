# test3-thinking — live thinking stream, every agent at once

```bash
bun smoke-tests/test3-thinking/thinking-smoke.ts            # every agent on PATH
bun smoke-tests/test3-thinking/thinking-smoke.ts claude codex
bun smoke-tests/test3-thinking/thinking-smoke.ts --wire      # raw protocol per agent
```

test2 covers tool calls. This covers **thinking** — the one activity kind that crosses the
wire incrementally, and therefore the one where a consumer can silently see *nothing* while
the model works.

It exists because of a real bug. `wireFrames` used to open a thinking block with a delta;
`foldFrame` correctly drops a delta whose base it never saw, so the whole block streamed to
nobody and appeared only when it **closed**. Final state was perfect, which is exactly why
the round-trip tests missed it. **Every check here asserts on intermediate state.**

## The task

> Work out by reasoning alone: how many four-digit numbers have four distinct digits summing
> to exactly 9? Then read `answer.txt` and say how far off you were.

Two properties make this the right shape:

- **It forces reasoning.** The prompt forbids writing code for step 1, so the model has to
  actually think rather than shell out to a one-liner. That is what produces thought chunks.
- **The file read is the proof of life.** One trivial tool call, no shell skills required —
  and since the count exists only in a file the agent had to open, a reply citing it is
  evidence the turn really ran. (test2 is where tool calls get exercised properly.)

The correct answer is **brute-forced by the script**, never hardcoded, so the ground truth
cannot be wrong. It's 54.

## Running every agent at once

All agents run **in parallel**, one session each, in separate temp working directories, with
separate transcripts. Output is buffered per agent and printed in blocks — interleaved
streaming from four models is unreadable.

`createSession()` is **a branch per agent, not a config table** — deliberately. Making a
model think is a per-provider knob in a per-provider *place*, and those differences are the
interesting part of this test; spelled out they are visible and tweakable, in a lookup table
they become anonymous strings. Tune the constants at the top and re-run to compare.

| Agent | Where the knob lives | Set with |
|---|---|---|
| Kimi | nowhere — thinks by default | — |
| Claude | **environment** of the bridge process; `claude-code-acp` reads `MAX_THINKING_TOKENS` at `session/new`, and without it Claude emits no thought chunks at all | `env` on `AgentSession.create` |
| Codex | **ACP session config option** — `reasoning_effort`, `low`…`ultra`, default `medium` | `session.setConfig("reasoning_effort", …)` after connect |

Three different mechanisms for the same concept, which is why the branch is worth the
duplication. The Codex one is the trap: `-c model_reasoning_effort=…` on the command line
does **nothing** — `codex-acp` embeds Codex rather than shelling out to it and silently
ignores the extra argv. The knob is only reachable over the protocol, after the session
exists. The run reads the value back from the agent afterwards and reports
`DID NOT TAKE` rather than claiming a tuning it didn't get.

`CLAUDECODE` is deleted from the environment at startup — Claude Code refuses to launch
inside another Claude Code session, and says so only on stderr.

An agent that doesn't think is reported **SKIPPED, not passed**. Whether a model reasons is
its own decision and configuration; it is not a property of this library.

## What it checks

| Check | What breaks it |
|---|---|
| thinking was visible while it streamed | **the regression this test exists for** — a block that only materializes when it closes. Shows up as `steps == blocks` instead of `steps == chunks` |
| each block only ever grew, by appending | a delta applied to the wrong base, or state rewritten rather than extended |
| the wire carried O(text), not O(text²) | full state on every frame. Expected cost is exactly 2× (once streaming, once settled); resending the block per chunk is quadratic |
| one transcript line per block, settled | thinking persisted per chunk instead of per block |
| the live fold and the transcript fold agree | fold drift on the one kind that crosses incrementally |
| the agent read `answer.txt` | the turn didn't really run, or the cwd wiring is wrong |
| activity stayed inside the turn's msg fences | broken turn grouping |
| the snapshot is idle after the turn | the between-turns replay contract |
| messages round-trip | the persisted reply drifting from what streamed |

Exit codes: `0` all passed, `1` a check failed, `2` nothing could run (no agent on PATH, or
no agent produced thinking).

## Measured

```
codex      4 chunks -> 1 block ->  1 line,  95 chars    190 chars sent (2.0×) vs 300 resending (3.2×)
claude    15 chunks -> 1 block ->  1 line, 936 chars   1872 chars sent (2.0×) vs 9053 resending (9.7×)
```

`15 visible updates from 15 chunks` is the number that matters: under the bug the ceiling
was 1 — one update per block, at close. The quadratic column is the cost the delta path
avoids, and it grows with block length: ~9.7× on a 936-character block, ~200× on 400 chunks.

The two agents exercise **different id paths**, which is the useful part of running them
together: Codex sends a `messageId`, so its block is keyed straight from the protocol
(`think-rs_0a6bf485…`); Claude sends none, so the block falls back to the minted per-turn
counter (`ms7t6xabbyb8:think-1` — prefixed, or a second turn would collide with the first).
Kimi behaves like Claude here.

## Files

`chats/` holds one transcript per agent per run (`<agent>-thinking-<stamp>.jsonl`).
`*.wire.jsonl` is **gitignored** — a wire log contains everything the agent said.
