# Operation lifecycle smoke test

Freezes, kills and cancels a harness and checks that every request ends visibly and the conversation
keeps working afterwards (see `.res/somelogs.md/9-22+/10-17-SPEC-operation-lifecycle.md`). It is the
acceptance test of the operation lifecycle on real harnesses; the same behaviour is covered
deterministically by `test/operation-*.test.ts`.

```sh
ACP_TEST13_ADAPTER=mock bun smoke-tests/test13-operationLifecycle/index.ts      # scripted agent: free, deterministic
ACP_TEST13_ADAPTER=codex ACP_TEST13_FIRST_OUTPUT_MS=15000 ACP_TEST13_NEXT_OUTPUT_MS=15000 \
  bun smoke-tests/test13-operationLifecycle/index.ts                            # real harness: spends tokens
```

Only newly created throwaway conversations are used. The model is not selected; the harness uses its own
configured one. To run OpenCode with a specific model for one run without touching its config, set
`OPENCODE_CONFIG_CONTENT='{"model":"<provider>/<model>"}'` (the harness inherits the environment).

Each run replaces `agent.sqlite`, `agent.sqlite-recovery` (s6) and `results.json` in the data directory
(all git-ignored). Every
scenario runs even when an earlier one fails; failures are printed, saved in `results.json`, and set exit
code 1. Progress is printed before each operation, with an elapsed-time heartbeat every ten seconds.

The launcher writes the PID of the harness it spawns to `harness.pid`; the freeze and kill scenarios signal
only that process, never an existing session.

## Variables

All optional.

| variable | meaning |
|---|---|
| `ACP_TEST13_ADAPTER` | `mock` (default), `codex`, `claude`, `opencode`, or any id in `ADAPTERS` |
| `ACP_TEST13_DATA_DIR` | where `agent.sqlite`, `results.json` and `harness.pid` go (default: this directory) |
| `ACP_TEST13_ONLY` | e.g. `s2,s3` to run only some scenarios (default: all) |
| `ACP_TEST13_FIRST_OUTPUT_MS`, `ACP_TEST13_NEXT_OUTPUT_MS` | turn silence limits (default 5000). Use 15000 for real harnesses, 60000 for OpenCode (see results) |
| `ACP_TEST13_CANCEL_GRACE_MS` | cancel grace before the process is killed (default 1000) |
| `ACP_TEST13_RUNS` | repetitions of m1 (default 3) |
| `ACP_TEST13_HISTORY_TURNS` | short prompts added before m1's cancel and load, to measure a longer replay (default 0) |

A quick mock fault run:
`ACP_TEST13_ONLY=s2,s3 ACP_TEST13_FIRST_OUTPUT_MS=100 ACP_TEST13_NEXT_OUTPUT_MS=100 ACP_TEST13_CANCEL_GRACE_MS=100 bun smoke-tests/test13-operationLifecycle/index.ts`.

## Scenarios

| id | what | checks |
|---|---|---|
| s1 | Interrupt while the permission handler never answers | the handler's AbortSignal fires, the prompt resolves `cancelled`, the next prompt completes. The harness must actually ask for permission; one that auto-approves or asks in chat is reported as a failure (a coverage gap, not a library defect). OpenCode asks when run with `OPENCODE_CONFIG_CONTENT='{"model":"…","permission":{"bash":"ask","edit":"ask"}}'` |
| s2 | SIGSTOP the harness, then prompt | the prompt rejects `stalled`, phase `no_response`, `cancel: "forced"`; one stored `stalled` error record; the next prompt reloads the same session (`provider_reconnected`, `via: "loaded"`) and remembers a keyword |
| s3 | SIGKILL the harness during a prompt | the killed prompt rejects; the next prompt reloads the same session and remembers the keyword |
| s4 | SIGSTOP with one queued message and two steers pending | the stall error's `followedBy` names both steers; they go out as one prompt delivered `via: "stall"`; the queued message is held, then released and completed |
| s5 | A tool that runs longer than both silence limits (mock: 100ms limits, 150ms tool; real: 15s limits, `sleep 20`) | not stale; the turn completes |
| s6 | The harness lost the session after a crash: the process is stopped and the session deleted in the harness (`session/delete`; OpenCode, which lacks it over ACP, through `opencode session delete`). Only sessions this run created are deleted | without a checkpoint, the next prompt rejects `provider_session_missing` and `promptability` reports `continuation_unavailable`; on a second Agent with `onLoadFailure: "recover"` and a published checkpoint, the next prompt recovers in place (`via: "recovered"`, a new provider session) and remembers the keyword |
| m1 | Measurement, repeated `ACP_TEST13_RUNS` times | first output, the longest gap without a running tool, cancel latency, and `session/load` time with its replay gaps |

A short normal completion before m1's interrupt is reported as `cancelStatus: "completed"`; its latency is
then not a cancel latency.

## Reading the results

`results.json` holds `{ adapterId, measurements, failures }`. s4 saves the live message events
(`message_*`), which are not stored. Stored records are read through the persistence API:
`agent.persistence.records.list(conversationId, { kinds: ["error"] })` for the stall errors and
`agent.persistence.providerSessions.active(conversationId)` for the provider mapping.

## Results

Checked into `measurements/`. None of these runs exercises automatic compaction, so the 120/180-second
silence defaults and the 30-second cancel grace remain conservative.

### 2026-10-18

- Mock: all scenarios passed.
- Codex: freeze, crash, steer and long-tool checks passed; s1 produced no native permission request.
  A further m1 run with 24 history turns replayed 53 updates in 554ms, with a 535ms maximum gap.
- Claude: m1 only.
- OpenCode: its default upstream rejected every model call (free-tier policy); nothing was changed.

### 2026-10-19 (after the review fixes)

- Codex and Claude, 5000ms limits: Codex passed s2, s5 and m1 ×3; Claude passed s3, s4 and m1 ×2. The
  other stalls (Codex s3, s4; Claude s2, m1 run 2) were real silences longer than 5 seconds, mostly on the
  prompt right after a reconnect. Rerun with 15000ms limits they all passed. Neither asked for permission
  in s1, and Claude did not run the s5 tool. Claude m1: first output 2–5ms, longest gap 1.4–2.3s, cancel
  3–7ms, load 750–1001ms.
- OpenCode, default model: rejected upstream from this network (free-model IP block).
- OpenCode with `opencode-go/deepseek-v4.1-flash` (set for the run only), 15000ms limits: s5 and m1 ×3
  passed (first output 2–3ms, longest gap 2.1–4.2s, cancel 67–91ms, load 554–592ms); s1 got a chat
  question instead of a permission request; s2, s3 and s4 stalled on the first prompt after the
  reconnect. With 60000ms limits s2–s4 passed. Cause, a harness behaviour: when a reloaded session has a
  turn that was cut off, OpenCode first completes that interrupted request and only then answers the new
  prompt, so the reply can be silent for more than 15 seconds and contain the old turn's output (in s3, an
  8,800-character story followed by the keyword).
- s6 on Codex, Claude and OpenCode (DeepSeek V4.1 Flash): the first run failed on Codex and Claude,
  because the library did not recognise their "session missing" errors and treated them as temporary,
  so every prompt would have failed. Claude reports `-32002 Resource not found`; Codex reports a deleted
  session as `-32603` with "session … is archived. Run `codex unarchive …`" in `data.details`. Both are
  now recognised (`isMissingProviderSessionError`). OpenCode's `-32603 OpenCode service failure`
  (`service: "session"`) was already recognised. After the fix s6 passed on all three.

### 2026-10-19 (s1 on a real harness)

- OpenCode 1.18.34 with `OPENCODE_CONFIG_CONTENT='{"model":"opencode-go/deepseek-v4.1-flash","permission":{"bash":"ask","edit":"ask"}}'`
  (for the run only) and 60000ms limits: the model ran `pwd` through its bash tool, OpenCode sent
  `session/request_permission`, and s1 passed: the handler's AbortSignal fired, the prompt resolved `cancelled`
  (`cancel: "acknowledged"`) and the next prompt completed, 2.2s from interrupt to the next reply. The real s1 prompt
  now tells the model to call the tool without asking first, so it no longer asks in chat.
  `measurements/2026-10-19-opencode-s1.json`.
