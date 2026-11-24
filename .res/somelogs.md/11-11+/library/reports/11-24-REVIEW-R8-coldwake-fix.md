# Review: cold-wake fix (`joint-r8-rh2` e88dac7) and the wall-timer test (d896ee7)

Reviewer: clad2a-s. Clean `git archive` on `/dev/shm`; no `src/` edits; mutations and probes on separate copies. Head re-checked: d896ee7 (test-only on top of e88dac7).

Verdict: **approve the fix.** It removes the root cause for the reachable cases in the class; the regression test is deterministic and killed by restoring detach-first. Two things to act on, neither a product bug: the production-launcher
joint test has a timing flake (3 failures in about 220 whole-file runs under 4-way load), and a few lines of the fix are not pinned by tests.

## Root cause and fix

`stop()` set `#connection = null` first, then awaited `client.stop()`. `notifyReminder` only accepted frames when `this.#connection === connection`, so a non-null `reminders_due` the harness emitted while it was stopping was dropped:
SQLite kept revision 0 / `nextDueAt` null and no cold timer was armed (host stopped, one launch). Reproduced by me deterministically on 5a4b4d5 (below).

The fix: `#stoppingConnection` holds the detached connection in the same synchronous statement that nulls `#connection` (and again after any in-flight start completes); `notifyReminder` accepts **deadline** frames from it; `stop()` awaits
`reminderSync.settled()` before `kill()` so the queued persistence drains; the reference is cleared in the `finally`. Only deadline frames are accepted from the stopping connection; channel events (`reminder_fired`/`changed`/...) are still dropped there.

## (1) The whole class

| Moment | Result |
|---|---|
| deadline frame arriving after an explicit stop begins | now persisted (was the bug) |
| arriving while `stop()` waits for an idle-stop in flight | accepted: `#connection` is still the live one until `stop()` takes it |
| arriving while a start is in flight (open not finished) | buffered in `earlyReminders` and replayed after open; if the open fails the open is repeated and its response carries the authoritative `nextDueAt` |
| arriving after `client.stop()` replied and before the kill | none expected (the harness has stopped); the connection is still `#stoppingConnection`, so it would be accepted |
| after the stop completed | connection dead; nothing arrives |
| `agent.close()` | `closeReminderSupervisors()` first, then `nativeHarness.stop()`: same `stop()` path, so covered; the stored wake remains and the supervisor is deliberately not re-armed |
| idle stop (`#idleStop`) | `#connection` is only nulled after the stop reply **and** `await reminderSync.settled()`, so frames ahead of the reply are processed first |
| unexpected connection loss (`#lost`) | `#connection` is nulled at the start of `#lost`, so a deadline frame still unread at that moment would be dropped. I tested whether it can happen with the real transport: a child that prints a `reminders_due` frame and exits immediately, through `launchNativeConnection`, 450 runs (150 idle, 300 with 14 CPU busy-loops): the frame was delivered before `connection.closed` resolved **450/450**; none late or lost. The reachable ordering is safe because the frame is delivered synchronously from the stdout reader and `#lost` additionally runs behind `await #starting`/`await #idling`. No evidence of the same bug there; a stress test of loss with an in-flight deadline frame does not exist in the suite |

Dropped by design, worth stating: channel events (`reminder_fired`, `reminder_changed`, `reminder_cancelled`, `reminder_expired`) arriving during an explicit stop are not applied or forwarded; the cache catches up in the next open's sweep and the notice itself is durable in the
harness. The conversation ports are already failed by the stop. Not a deadline loss.

## (2) Regression test and mutations

The test holds every non-null `reminders_due` from the real harness until `client.stop()` is called, releases it synchronously inside the stop wrapper (after `stop()` has detached the connection) and asserts the reported `nextDueAt` equals the due time right after
`stop()`, then that the first owner re-arms, the second owner re-arms after close, and a single fire happens on the original channel; the `until`s are now labelled.
- On 5a4b4d5 with the new test file: **fails 3/3** (`Expected: <due>, Received: null`).
- Mutants on the fixed code: restore detach-first (drop the `#stoppingConnection` branch): **killed**. Not killed (so unpinned): dropping `await reminderSync.settled()` before `kill()` (the stop round-trip outlasts the SQLite write, so the test cannot tell; a slow-write test like the idle one would pin it);
  dropping the second `#stoppingConnection` assignment (stop that adopts a connection from an in-flight start; no test); accepting every event kind from the stopping connection (no test pins "channel events dropped"); not clearing `#stoppingConnection` afterwards (equivalent except it keeps the dead connection referenced).

## d896ee7: the wall-timer test

It now warms the real harness first, creates the reminder through a real `reminder/change` (no local journal, no cold timer), records the deadline notifications from the real child (`{1, due}` then `{2, null}`), invokes the **superseded** cold callback at due
(captured from a provisional reminder that was then cancelled), and asserts one `reminder_fired` and `host.launches === 1`.
- It proves the real harness timer fires exactly once and that a stale cold callback cannot cause a second firing or launch. It does **not** prove "a current cold timer racing the harness timer": by design no timer is armed while the harness runs, and the stale callback is inert (`armed.target !== target`), so a double launch cannot show either way because starts are single-flight.
- Mutants: duplicate event delivery: **killed** (6 tests). Dropping the host's deadline record: **killed** (2 tests). Arming the cold wake while running (both guards removed): **killed only by the production-launcher test**, no longer by this one (it asserts the timer map empty right after the start but not after the live create). Removing the early-wake recheck: survives (unit-covered).
  If you want it killed here too, assert `clock.delays` is `[]` after the live `changeReminder` as well.

## (3) Stress (whole joint file, 4 loops in parallel)

- On d896ee7 (test-only change over e88dac7): about **220 whole-file runs** under 4-way load. **0 failures** in `joint cold wake survives...` (the earlier intermittent) and **0** in the wall-timer test.
- **3 failures, all the same test: `joint production launcher delivers one fire, deadline update, cache change and notice`**, at `reminders-joint.test.ts:457`: `expect(reported).toMatchObject({ revision: 1, nextDueAt: due })` received `{ revision: 2, nextDueAt: null }`. That is a **test-timing flake, not a product fault**: the test creates the reminder due in 1.5 s *before*
  `host.start()`; under load the start takes longer than that, so the harness has already fired and advanced to revision 2. The behaviour observed is the correct one. Fix the test: start the host first and create the reminder through a live change (like the wall-timer test), or use a
  lead of several seconds via the historical-anchor trick.

## (4) Gate and scope

- `tsc --noEmit`: exit 0. Plain `bun test` on e88dac7: 2,148 pass / 0 fail / 223 files; re-run with the d896ee7 test file: **2,148 pass / 0 fail / 223 files, 35 snapshots**, no `.snap` change.
- `src/native-harness/` vs `d9f24b8`: **empty diff** (checked on d896ee7). Ceilings: host **909** (at the ceiling, not above), native/controller 591 (599), agent-session 4,491, agent 563.

## Requests

1. Deflake the production-launcher test (above). It is the only failure seen in about 220 runs.
2. Optional pins: a slow-write test for `settled()` before `kill()`, and one for stop adopting an in-flight start's connection.
3. Optional: a loss-with-in-flight-deadline stress test, since the reasoning that `#lost` is safe depends on frame delivery preceding `closed`.
