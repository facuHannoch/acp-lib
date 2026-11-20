# Report: Brief A1, characterization tests (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `e4ecb7e`), Implementation briefs, Brief A1.
Branch: `controller-interface`, created from beta `e4ecb7e`. Nothing under `src/` touched
(`git diff --stat e4ecb7e -- src` is empty).

## Commits

| Commit | Step | Content |
| --- | --- | --- |
| `f5e724c` | 1 | `test/conversation-turns/normalize.ts` |
| `52050ee` | 2, all-modes group | `test/conversation-turns/characterization.test.ts` and its `__snapshots__` (23 cases) |
| `686d401` | 2, the rest | once-only cases (12), `test/fixtures/auth-required-agent.ts` (new), `test/fixtures/lifecycle-agent.ts` (opt-in end delay) |
| `a6d0945` | | this report, first version |
| `80eeb10` | review P2 | the instant tool-start case waits on a commit event instead of a fixed delay (`characterization.test.ts`, `lifecycle-agent.ts`); snapshots unchanged |
| `6957407` | | this report, updated after the independent review (`11-12-REVIEW-A1.md`, reviewer commit `064e3ce`) |
| `50cd497` | outside A1, user-approved | `fix:` `InternalInferenceManager.close()` stops the heartbeat of executions it fences, plus a regression test (`src/internal-inference/coordination/manager.ts`, `test/internal-inference/manager.test.ts`); its own commit, separate from the A1 tests |
| this commit | | this report, updated for the heartbeat fix and the green gate |

The all-modes group went in first, in its own commit, because it guards A2. Committing the
once-only group changed no line of the all-modes snapshots: the snapshot diff in `686d401` is
additions only.

## Gate results

### With the heartbeat fix (`50cd497`): gate met

| Gate | Result |
| --- | --- |
| `bun run typecheck` | clean, 2.8 s |
| full suite `bun test` | **green: 1,132 pass, 0 fail; 1,132 tests in 113 files; 88.7 s** (1,096 baseline + 35 characterization + 1 regression test); 35 snapshots matched; A1 snapshot file untouched |
| regression test before the fix | fails with the original stack (closed-SQLite write from the heartbeat at `manager.ts:241`) |
| `manager.test.ts` after the fix | 9 pass, 0 fail, three runs |
| the original reproduction (`manager.test.ts` followed by a 12 s idle test) | 10 pass, 0 fail (it failed before the fix) |

The fix: the active execution keeps its heartbeat handle; `close()` clears it for each execution
it fences; a beat for a fenced execution also stops itself. The regression test runs an
abort-ignoring runtime with a 250 ms heartbeat, closes the Agent, and asserts no further heartbeat
call over three intervals and no unhandled rejection. Checking that something does *not* happen
needs a time window; that window is the only wait in it.

### After the review fix (`80eeb10`)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | clean, 2.8 s; new test files clean under the temporary tsconfig |
| characterization file, three runs without update | 35 pass each (12.8 s, 12.6 s, 12.5 s); snapshot unchanged each run, SHA-256 `e19d85c8fed49ff4…`, the same hash the reviewer recorded for `a6d0945` |
| gated case alone | 15/15 pass, and 10/10 more while two busy loops loaded the CPU; snapshot untouched |
| full suite `bun test` | **still red: 1,130 pass, 1 fail, 1 error; 1,131 tests in 113 files; 84.4 s.** The failure is only the P1 heartbeat (the bridge case again), unchanged by this fix and not addressed in A1 |
| full suite without `manager.test.ts`, plus that file alone | 1,123 pass, 0 fail, 86.5 s; then 8 pass, 0 fail. Supporting evidence only: separate subsets do not meet the gate |

### First version (`686d401`)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | clean, 3.0 s (the project's tsconfig covers `src/` only, so the new test files were also typechecked with a temporary tsconfig outside the repo that extends it: clean) |
| characterization file, three runs | 35 pass each run, about 13 s each; snapshot file unchanged after each run (`git diff --quiet`). Stronger check: three regenerations with `--update-snapshots` produced a byte-identical file. Five more plain runs before that were also identical. |
| full suite `bun test` | **1,130 pass, 1 fail; 1,131 tests in 113 files; 89.7 s.** The failure is not an A1 defect (next section). |
| full suite without `test/internal-inference/manager.test.ts`, plus that file alone | 1,123 pass, 0 fail, 112 files, 87.7 s; then 8 pass, 0 fail. Total 1,131 = 1,096 baseline + 35 new, all passing. |
| baseline before A1 (same machine) | typecheck clean 3.1 s; 1,096 pass, 112 files, 77.8 s |

### The full-suite failure: a pre-existing leaked heartbeat (blocks "suite green")

`test/internal-inference/manager.test.ts`, test "fences an abort-ignoring runtime and durably
schedules shutdown recovery", runs a runtime whose `run()` never settles, then closes the Agent.
`InternalInferenceManager.close()` (`src/internal-inference/coordination/manager.ts:157`) fences the
execution but never clears its heartbeat `setInterval` (created at `:240`; cleared only in
`execute`'s `finally`, which never runs). Every 10 s (`heartbeatIntervalMs` default) the interval
writes to the closed SQLite backend. The write's promise is discarded with `void`, so it surfaces as
an unhandled error ("SQLite persistence backend is closed"), and Bun fails whichever test is running
at that moment.

On beta, `manager.test.ts` is the last file Bun runs, so the process exits before the first beat.
The new `test/conversation-turns/` directory runs after it. About 10 s into this file the beat lands
in the bridge case, which Bun then fails (also aborting its body, so `afterEach` removes the temp
`cwd` and a follow-on `posix_spawn 'bun'` ENOENT shows up as well).

Reproduction without any A1 code: `bun test test/internal-inference/manager.test.ts <any test that
idles 12 s>` fails the idle test with the same error.

I did not work around it. A1 must not touch `src/`, and masking it in that unrelated test (for
example a very long `heartbeatIntervalMs` there) would hide a library bug. **Decision needed:** see
open question 1.

## Cases and modes

"All three" means Agent-owned (an `Agent` with SQLite; records read back with
`agent.persistence.records.list` plus the committed-record bus), managed (a `SessionManager`
session, v2 transcript preset `activity`; the JSONL transcript read back) and detached (an
`AgentSession` with a legacy `transcriptPath`; the JSONL read back). Each case snapshots, after
`normalize`: the turn, message and record events (kind, ids, order), the records, and the prompt
results or rejections.

| Case | Fixture | Modes |
| --- | --- | --- |
| a plain prompt | echo-prompt | all three |
| a second prompt queued behind a running one (`delivery: "queue"` after `turn_started`) | echo-prompt (`SLOW_TURN`) | all three |
| two steer messages combined into one run (`message_delivered { ids: [a, b] }`, run on `a`'s id) | steer | all three |
| an interrupt of the running turn (during a tool; cancel acknowledged) | lifecycle (`tool`) | all three |
| a stalled prompt (turn limits 30 ms; partial reply; cancel forced) | lifecycle (`partial`) | all three |
| a permission request answered through `onPermissionRequest` | lifecycle (`permission`) | all three |
| an internal command (`executeInternalSessionCommand("status")`) | operations-agent (smoke-tests fake) | all three |
| a handoff with a generated summary, then a prompt on the target | lifecycle | Agent-owned, managed |
| a queued message withdrawn (second `withdraw()` returns false; cancelled result) | echo-prompt | once, Agent-owned |
| an interrupt with `clearQueue` dropping a queued and a steer message | lifecycle (`tool`) | once, Agent-owned |
| a provider that fails to start (load fails after `forceStop`; prompt rejects; `turn_failed`) | lifecycle (`LIFECYCLE_FAIL_LOAD_FILE`) | once, Agent-owned |
| a PTY start: `{ sessionId: "", resumed: false }` twice, no progress events, `capabilities` throws | idle-pty | once, **controller level** |
| session creation refused for authentication: empty session id, only `initialized`, connection usable; then `authenticate`, `startFresh` and a prompt succeed | auth-required (new) | once, **controller level** |
| the same refusal seen through a conversation (`AgentSession.create` resolves; the prompt rejects with "Authentication required") | auth-required (new) | once, detached |
| `bridge` from degraded mode and from normal mode | idle-pty + echo-prompt | once: degraded on a controller, normal on a detached conversation |
| `capabilities.agent.promptCapabilities` before and after start | echo-prompt | once: controller before/after `start`; Agent-owned conversation after create, after `forceStop`, after reconnect |
| an internal prompt (handoff summary) that stalls in a tool, cancel acknowledged | lifecycle (`summaryInstructions: "[lifecycle:tool]"`, `internalInference.toolMs: 30`) | once, Agent-owned |
| an internal prompt (handoff summary) that stalls silently, cancel forced | lifecycle (`"[lifecycle:silent]"`) | once, Agent-owned |
| a permission request the instant the prompt arrives: stages `waiting → awaiting_permission → streaming` | lifecycle (`permission`) | once, Agent-owned |
| a tool start the instant the prompt arrives: stages `waiting → tool_running → streaming` | lifecycle (`tool`) | once, Agent-owned |

Totals: 23 all-modes tests (8 cases × 3 modes, minus the detached handoff), 12 once-only tests.
35 snapshots.

## Deviations and why

1. **Startup cases at controller level.** The PTY start and the authentication refusal assert
   `start`'s result and progress events, which are the controller's contract in the spec (Startup).
   No conversation API exposes the raw `AgentControllerStartEvent` stream for a PTY or a refused
   session, so they run on `AgentController` directly. The authentication case also has a
   conversation-level twin (detached). These tests construct `AgentController` by name. B1 keeps it
   as a deprecated alias, so they keep compiling.
2. **Bridge: path asserted, terminal driven only lightly.** The bridge runs over `PassThrough`
   streams: it types bytes and sends the exit chord (Ctrl-]). The snapshot pins which path ran,
   counted with `spyOn(PtyClient.prototype, start/bridge/stop)`. Degraded mode bridges the live PTY
   (no new `start`, no `stop`, still connected). Normal mode starts, bridges and stops one temporary
   PTY, and the ACP session is untouched (same internal session id, still connected, mode `normal`,
   a prompt afterwards succeeds). It also pins the status lines and the screen clear. Raw terminal
   output is not snapshotted because it is timing-dependent.
3. **Capabilities "before start" for a conversation.** An Agent-owned conversation is connected as
   soon as `conversations.create()` resolves, so it has no "before connect" moment. The case pins
   the controller before and after `start` (throws `NotConnectedError`, then a value), and the
   conversation after create (value), after `connection.forceStop()` (throws `NotConnectedError`) and
   after the next prompt reconnects (value).
4. **"Cancelled by force" read as the cancel escalation ending in `forced`.** The internal prompt
   that stalls silently ignores the cancel and is forced after the grace period (`cancel: "forced"`).
   The other one, stalled in a tool, acknowledges it (`cancel: "acknowledged"`). Both snapshots pin
   the metering record (`handoff_summary`, outcome `cancelled`), the `cancelling` stage,
   `handoff_failed`, and zero `turn_*` events during the handoff (also asserted directly). If
   "by force" meant a consumer calling `forceStop` during an internal prompt, that case is not
   written.
5. **Background recovery checkpoints off in the Agent-owned set-up** (`checkpointing: { enabled:
   false }`). By default an Agent schedules a `conversation_checkpoint` internal inference after the
   first completed turn, which runs a second harness session concurrently with the case. It is not
   the turn path. Snapshots were identical with and without it. I first suspected it of the
   full-suite failure; it turned out not to be the cause, but it stays off to keep cases isolated.
6. **A commit-event barrier in the instant-tool case** (replaced a fixed delay after review). In the instant-tool case, the Agent-owned record order between the
   last chunk's in-progress message snapshot (`message:<turn>:assistant:1:snapshot:1`) and the
   metering record flipped between runs (about 2 of 12 one way). The cause is in today's code: the
   snapshot goes through the serialized `ownerRecordWrite` chain (`queueOwnedRecord`), while
   `ownerLifecycle.meteringRecorded` writes directly, so when the last chunk arrives in the same
   instant as the end of the turn, behind queued tool records, the two writes race. Following the
   spec's rule (wait on events, never loosen), the first version added a 100 ms delay in the fixture
   before the end of the turn. The review (P2) rightly called that a timer that masks the race, not
   a barrier. It is replaced (`80eeb10`) by an event barrier: the lifecycle fixture's opt-in
   `LIFECYCLE_END_GATE_FILE` makes the tool mode end the turn, after its last chunk, only once that
   file exists (a cancel while waiting still answers the prompt; without the variable, behaviour is
   unchanged for every existing test). The case subscribes to the Agent's committed-record bus and
   writes the file when the turn's in-progress assistant snapshot record is published, that is,
   once it is committed. The order the snapshot pins (message snapshot, then metering) now follows
   from that commit, not from wall-clock time: 15/15 runs, 10/10 under CPU load, the three-run
   check, and an unchanged snapshot. The tool start itself still reaches the client the instant the
   prompt arrives (stages `waiting → tool_running → streaming`). The permission cases, which end the
   same way but have no tool records queued ahead, were 12/12 stable without a barrier.
7. **Agent-owned capture.** The Agent-owned set-up uses `capture: { message: "content", error: "raw"
   }` (as the existing stall test does), so error records appear in the snapshots.
8. **Event capture is compact.** Events are kept with kind, ids and order. `turn_completed`,
   `metering_recorded`, `presentation_recorded` and `handoff_completed` are reduced to their ids and
   status; the full results and records are snapshotted separately. `state_changed` is not captured.
   `operation_stage_changed` is captured only where a case is about stages (internal-prompt stalls,
   instant boundaries).

## `agent-session.ts`

5,022 lines (unchanged; A1 does not touch `src/`).

## Normalization (what is replaced, what is kept)

- **Replaced:** identifiers become `<id:N>`, numbered by first appearance in a sorted-key walk;
  equal ids stay equal, including inside composite record ids (`<id:1>:user`,
  `message:<id:1>:assistant:1:snapshot:1`). This covers values under id keys, UUIDs, and minted
  operation ids found by their base-36 timestamp prefix. Also: 64-hex digests become `<hash:N>`;
  ISO and epoch timestamps and `*At`/`ts` fields become `<ts>`; temporary paths become `<tmp>`;
  `pid=` values become `<pid>`.
- **Dropped:** duration and process-id fields.
- **Kept:** array order, record sequence numbers, transcript `seq`.

## Limitations

- **Full-suite gate:** green only with the separate heartbeat fix (`50cd497`). The A1 commits alone
  are red, from that pre-existing defect.
- **A known order race in Agent-owned records** (deviation 6). The instant-tool case pins the
  order with the barrier: the final chunk is committed before the provider result. It does not
  characterize a chunk and result delivered in the same instant; today's code fixes no order for
  that, so A2 cannot be checked against one. This narrowing is deliberate.
- **Error message texts are pinned**, for example "AgentController is not started — call start()
  first" and "operation requires ACP (normal) mode — the controller is degraded (pty)". If B1's
  rename changes those strings, the A1 capability and PTY snapshots change (open question 2).
- **Fixture prompt text is pinned.** The handoff snapshots include the library's summary prompt
  text, echoed back by the lifecycle fixture, so a change to that prompt text shows up as a
  snapshot change.

## Open questions

1. **Resolved:** the user approved a `src/` fix, done in `50cd497`. Original text follows. **The leaked internal-inference heartbeat** (review P1, reproduced independently on unchanged beta). It makes the full suite fail once any test file
   runs after `test/internal-inference/manager.test.ts`. Options:
   - (a) a `src/` fix: `InternalInferenceManager.close()` clears the heartbeat of executions it
     fences. It is a library bug, but outside A1's scope and outside the controller-interface spec,
     so it needs the user's go-ahead (a separate small commit, before A2's gate).
   - (b) a test-only mitigation in `manager.test.ts`, such as a very long `heartbeatIntervalMs` in
     that one test, or closing the leaked interval. This hides the bug rather than fixing it.
   - (c) accept a known red suite until fixed. Not recommended: A2's gate is "suite green".
   I recommend (a), with a regression test.
2. Should B1's rename keep the error texts that name `AgentController` (pinned by A1), or may it
   change them in its own commit, like A2's `cause` exception?
3. Is the controller-level placement of the PTY and authentication startup cases acceptable as the
   characterization of the start contract (deviation 1)?
