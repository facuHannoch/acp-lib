# Review — flake fixes and B2 follow-ups

This review covers `d11cd18..f30f3e3` on `controller-interface-verify`:

- `d3f7544` bridge;
- `6f7fddf` checkpoint;
- `49aa652` operation lifecycle;
- `a12a47d` fake replay;
- `3c6dc8f` changelog;
- `66fa496` conformance header;
- the report at `f30f3e3`.

I read it through `git diff`/`git show` and `git archive`, and didn't check out the branch. I didn't review the native
source fixes that come after `f30f3e3`.

**Verdict: no blocking findings.** Every fix except the two continuation tests removes the timing cause. Those two
only get a longer bound, which I accept with a reason below. The fixture changes are opt-in. The new fake case fails
on the old fake. The four new full-run failures look like load timeouts, not races in `src/`.

## (1) No `src/` or snapshot changes: holds

`git diff --name-only d11cd18 f30f3e3` shows only report files, `CHANGELOG-controller-interface.md`, and files
under `test/`: four test files, `conformance.ts`, `fake-controller.ts`, and two fixtures. There's no `src/` path and
no `__snapshots__` path. The characterization snapshot hash is still `fbc6ec2c…` after all my runs.

## (2) Cause removed, or just a longer limit?

| Commit | Assessment |
| --- | --- |
| `d3f7544` bridge | **Cause removed.** The fixed `Bun.sleep(50)` is replaced by waiting for the fixture's `idle pty received input` echo. The polling `until(status)` is replaced by the `onStatus` callback event. Each wait has a named limit (15/10/10 s). If the bridge closes early, the test fails at once instead of hanging. `input.end(0x1d)` in `finally` makes sure the bridge is always told to exit. The snapshot keeps only `status` and `wroteClearScreen`, so the extra echo text doesn't change it. The test limit going from 20 s to 80 s is only the sum of those named waits. |
| `6f7fddf` checkpoint | **Cause removed.** `performance.now()` is monotonic, so a WSL2 wall-clock jump can no longer end the 3 s poll early. This is the cause I identified in the A2 review. The assertions are unchanged. |
| `49aa652` cancellation-record test | **Cause removed.** The tool finished on a fixed 300 ms timer, and the steer had to be queued inside that window under load. Now it finishes when a gate file is written after the steer is queued. The grace went from 30 ms to 1 s: 30 ms was a real race for the fixture's cancel acknowledgement under load. The ignore case still ends `forced`, just a second later. The polling `until(stage)` became `waitForTurnStage`, which waits on events, is scoped to that turn's ID, has a 15 s limit, and rejects if the turn settles first. The expected records are unchanged. |
| `49aa652` the two continuation tests | **Only the limit is longer (5 s → 30 s), plus cleanup registration. Accepted.** These tests do real work: they spawn fixture processes, reload sessions, and do transcript I/O. They await that work and contain no fixed delays. The A2 failures were the 5 s default being exceeded under full-suite load. The later errors (missing transcript, `load_failed` instead of `missing`) came from teardown running while the body continued, not a first cause. Raising the limit covers exactly that and hides no wrong value, since the assertions still have to pass. The added `cleanups.push(() => created.stop())` also fixes a leak when the test fails early. If one of them ever fails *within* 30 s with the `load_failed`/`missing` mismatch, that would be a real finding. |

## (3) Fixture changes are opt-in: holds

- `idle-pty-agent.ts`: the echo is only installed with `--ack-input`, and only the bridge test passes that flag.
  Without it, the fixture behaves exactly as before.
- `lifecycle-agent.ts`: without `LIFECYCLE_TOOL_GATE_FILE` it still does `setTimeout(finishTool, LIFECYCLE_TOOL_MS ?? 150)`.
  The body of `finishTool` is the old timer callback plus a gate check that's skipped when no gate is set. So the
  default path is the same. Only the cancellation-record test sets the variable.

My three runs of characterization, checkpoint strategy, operation lifecycle and fake-only (77 tests, which include
all other lifecycle-fixture users in `operation-lifecycle.test.ts`) were all green.

## (4) `a12a47d`'s new case fails on the old fake: confirmed

I made a copy of the `f30f3e3` archive with `test/conversation-controller/fake-controller.ts` replaced by the
`d11cd18` version, then ran `fake-only.test.ts`:

- 9 pass, 1 fail. The failure was *"cancelling an ended held turn preserves its replay while a different turn
  stays live"* (expected 1 line, received 8).
- With the fixed fake, all 10 pass.

The fix (`if (replaying) return;` in the prepared turn's `cancel`) matches what I suggested in the B2 review.

## (5) The four full-run-1 failures

These are the three `agent-event-bus.test.ts` failures (prompt hook 11.4 s, rollback 24.6 s plus `SQLITE_CANTOPEN`,
streaming 7.8 s) and `native/host.test.ts:285` (5.05 s). They follow the same pattern as A2:

- default 5 s limits exceeded in one heavily loaded full run;
- the extra errors (closed SQLite backend, `SQLITE_CANTOPEN`, ACP close, `the native harness was stopped`) all come
  *after* the timeout, from teardown removing directories and processes while the test body was still running;
- all passed in full runs 2 and 3.

On a clean archive of `f30f3e3`, I ran `agent-event-bus.test.ts` and `native/host.test.ts` together 3 times: 40/40
each time (8.2–11.5 s).

The native one's name ("a push lost with its connection is settled") sounds like it could involve lost data. But it
failed by 50 ms over 5 s, and its note records no duplicate or missing input. **Test timing; accept.** If one of
these comes back in a later gate, give that file a longer explicit limit the way `49aa652` does. That's better than
rerunning until green.

## Docs

- `3c6dc8f`:
  - The heading now reads "including the native backend".
  - The withdrawal bullet now correctly says that a later turn naming a withdrawn message still runs, and only the
    message ID is ignored for settlement.
  - L71 names NativeController as the controller without `reconnect`.

  All three are correct against the code.
- `66fa496`: the header names all three subjects and drops the stale "no message payload" claim. Correct.

## My runs

Archive `/tmp/clad2a-ff.4von` (`f30f3e3`):

| Run | Files | Result |
| --- | --- | --- |
| 1–3 | characterization, checkpointing/strategy, operation-lifecycle, fake-only | 77 pass, 0 fail each (26.0 s, 30.3 s, 28.8 s); snapshot hash unchanged |
| 1–3 | agent-event-bus, native/host | 40 pass, 0 fail each |
| 1 | fake-only with the old fake (`/tmp/clad2a-ff-oldfake.Qz4m`) | 9 pass, 1 fail (the new case), as expected |

I didn't run the typecheck or the full suite. cod2a's full runs 2 and 3 (1,403/131) stand.
