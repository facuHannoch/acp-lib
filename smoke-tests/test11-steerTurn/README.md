# Steering feasibility smoke test

Drives the library's steering (`delivery: "steer"`, `interrupt()`, `withdraw()` and the message events,
see `.res/somelogs.md/9-22+/10-2-SPEC-steer-pending-messages.md`) against a real harness, and measures what
the harness does around a cancel. It is the acceptance test of the feature on real harnesses; the same
behavior is covered deterministically by `test/steering.test.ts`.

Like `end-to-end`: run it, and `agent.sqlite` appears in this directory (replaced on every run), with
one conversation per scenario. Each scenario prints its conversation id so you can find it in the
database. A summary is written to `results.json` next to it. Both are git-ignored.

```sh
bun smoke-tests/test11-steerTurn/index.ts                                  # codex (default; spends tokens)
ACP_TEST11_ADAPTER=opencode ACP_TEST11_MODEL=opencode-go/kimi-k2.6 bun smoke-tests/test11-steerTurn/index.ts
ACP_TEST11_ADAPTER=mock bun smoke-tests/test11-steerTurn/index.ts          # scripted agent: free, deterministic
```

The adapter must already be authenticated. Before any scenario, a preflight sends one short prompt; if the
harness answers with an API error (an unsupported model, an expired login) the run stops there and prints
the reply, because every scenario would otherwise measure nothing.

Configuration is by environment variable, all optional:

| variable | meaning |
|---|---|
| `ACP_TEST11_ADAPTER` | `codex` (default), `opencode`, or `mock` |
| `ACP_TEST11_MODEL` | set the model on the adapter (otherwise its own configured model is used) |
| `ACP_TEST11_DATA_DIR` | where `agent.sqlite` and `results.json` go (default: this directory) |
| `ACP_TEST11_ONLY` | e.g. `s1,s2` to run only some scenarios |
| `ACP_TEST11_RUNS` | repetitions for the race scenarios s3 and s6 (default 5) |
| `ACP_TEST11_SLEEP_WAIT` | seconds s5 waits to see whether the tool survived (default 22) |
| `ACP_TEST11_TURN_TIMEOUT` | seconds before a stuck turn fails (default 240) |
| `ACP_TEST11_CHECKPOINT` | `1` to also enable checkpointing and report whether one is produced |
| `ACP_TEST11_QUIET` | `1` to hide the live progress lines |

## Scenarios

The workspace holds `a.txt` (`kiwi`), `b.txt` (`banana`), `c.txt` (`fig`) and a throwaway `notes.md`.

| id | what | checks and measures |
|---|---|---|
| s1 | Control: read the three files one tool call at a time, to completion | baseline usage and metering |
| s2 | A `steer` message sent at the first tool call: "also include the length of each word" | the turn ends `cancelled` with `endedBy: "steer"` and `followedBy`; the follow-up continues the task; the message events; usage and metering of both turns |
| s2b | Two `steer` messages, the second a correction | both go out as one operation; the agent sees the whole correction; one stored user message per message sent |
| s3 | Several tool calls in one response, with a `steer` message, repeated | how the turn ends and how many tool calls ran, per run |
| s4 | A `steer` message plus `interrupt()` during a long text-only turn | `endedBy: "interrupt"`; whether the harness keeps the partial text; usage on cancel |
| s5 | `interrupt()` during `sleep 20 && echo done > done.txt` | does the tool survive the cancel, is anything half-done |
| s6 | `interrupt()` on the first chunk of a one-word reply, repeated | cancelled versus `end_turn` when the cancel races the end |
| s7 | After s2: "what did a.txt contain?" with no tools allowed | completed work still in the agent's context |
| s9 | Control: two plain turns, no cancel and no steering | whether the second turn is metered, to tell a metering limit of the harness from an effect of steering |
| s8 | `withdraw()` of a pending message | it settles as cancelled with no metering; the running turn is untouched |

The steer lands when a tool call settles and nothing else is running. Which call that is (the first of a
batch or the last) is the agent's choice and is not what is being measured.

## Reading the output

`PASS` / `FAIL` lines are checks with an expected answer; `·` lines are measurements. On a real harness
a `FAIL` is a finding, not a test failure (only the mock must pass outright). Results are also written as
JSON; the path is printed at the end.

For OpenCode, scenarios run with `billing_required` metering; compare the printed tokens and cost
reconciliation against the `opencode export <session id>` line printed as each conversation opens.

## Questions it answers

1. Is cancel reliable, and how fast does the cancelled response arrive?
2. Is usage reported on a cancelled turn, and is it complete?
3. How often does the boundary race occur?
4. Does the agent keep its completed work and its partial output after a cancel?
5. Does OpenCode's metering stay consistent (no blocked state, no double counting)?
6. What happens to a tool that is running when the cancel arrives?

## Files

- `index.ts`: the runner.
- `../../test/fixtures/steer-agent.ts`: scripted ACP agent, used for the free dry run (`ACP_TEST11_ADAPTER=mock`) and by
  `test/steering.test.ts`. It models no real harness.
