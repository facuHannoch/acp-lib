# Review: R8.5 typed harness client (`reminders-typed` at b2b4fbe, base alpha 4dad65e)

Reviewer: clad2a-s. Clean `git archive` on `/dev/shm`; no `src/` edits; mutations on a separate copy.

Verdict: **approve.** Behaviour is unchanged, the four call sites and the copied wire types are gone, the compile-time proof is live, and no change is needed for the R9 merge. Two notification-validation checks have no unit test; they also had none on alpha (pre-existing gap, listed below).

## Gate and scope

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,164 pass / 0 fail, 225 files, 35 snapshots** (matches cod2b-t).
- Joint real-stdio file: **20/20 whole-file runs green** (12 tests each).
- Ceilings: host 909 (= alpha, zero net), native/controller 591, agent-session 4,527 (= alpha's own), controller 764, client 1,050, conversation-manager 1,012, agent 563, engine 1,034, all as on 4dad65e.
- `src/native-harness/` vs alpha: **empty diff.**

## (1) Behaviour unchanged

Diff reviewed line by line; the only non-type edits are the call sites and one test.
- `reminderRpc(client, method, params)` (a cast around `client.request`) is replaced by the harness's typed methods, which are the same plain wrappers (`this.request("reminder/change"|"reminder/get"|"reminder/list", params)`; `stopIfIdle` sends `session/stop` with `{ ifIdle: true, unlessDueWithinMs }`). Same method names, same params.
- `recordReceipt`: the blocked branch still falls back to `"invalid_state"` when a reason is missing, an applied receipt without a row still throws, and **only `stale`/`conflict` log a defect** (mutant logging every reason: killed by the new unknown-reason test; mutant coercing an unknown reason to `invalid_state`: killed).
- Unknown/future reasons: the new test makes the peer return `future_harness_reason`; it is recorded, surfaces as `state: "blocked", reason` through create, get and the `reminder_intent_blocked` event, and no `reminder_receipt_conflict` is logged.
- `negotiatedLimits` and `initialize` keep the same runtime logic with typed parameters; `ReminderErrorCode` is rebuilt from the harness reason type plus five library codes and equals the old 14-member union (set compared by hand).
- Routines still refused: `routines_unavailable` thrown by the service before any write (tests pass); the adapter-level throw is only a backstop, see below.
- Public event union: `AgentSessionEvent` now includes `ConsumerReminderEvent` (derived from the harness event types, with `blockedReason` widened to `string` so future reasons stay representable). I compared it with the old hand-written `WireReminderEvent`: the two are **mutually assignable** (structurally equivalent), though not literally identical under a strict equality test. Event kinds and `ReminderErrorCode` members are unchanged; `ReminderEvent` untouched.

## (2) Call sites and casts

`reminderRpc` and its `as never` casts: gone (grep across `src` and `test`: no references). All four sites use `client.changeReminder`, `getReminder`, `listReminders` and `stopIfIdle`. The scripted peer now exposes `changeReminder/getReminder/listReminders/stopIfIdle` with the harness parameter types and returns its fixtures with harness types (`Reminder`, `ReminderChange`, `ReminderChangeResult`, `ReminderList`, `ConditionalStopParams`). Remaining `as never` in `test/native`: schedule stubs that are intentionally malformed legacy shapes (two), config stubs in wake and notification tests, and one idle-test fixture; none in production code.

## (3) Compile-time proof

`wire.typecheck.ts` constrains `ReturnType<typeof reminderRequest>` to the harness `ReminderChange`, and a `@ts-expect-error` asserts that a create payload without `acceptedAt` is not assignable.
- Remove the `@ts-expect-error`: tsc fails on that line (`MissingAcceptance` does not satisfy `ReminderChange`, `acceptedAt` missing): **the negative test is live.**
- Make the adapter's create drop `acceptedAt`: tsc fails in `wire.ts`. Add an extra field to an update payload: tsc fails. Both without any edit to the type test.
- Each adapter return uses `satisfies WireChange` (no cast). Remaining `as` in `wire.ts` are at the unvalidated JSON boundary in `reminderNotification` (`frame`, `params.event`, `fields`, and the final `as WireReminderEvent` after the runtime allowlist and field checks); I found no `any`, and no casts on the request side.
- Note: `wire.typecheck.ts` lives under `src/` and so ships in the package tarball; harmless (never imported) but consider moving it to a test-only path if you want it out of the tarball.

## (4) Notification routes and runtime checks (mutations; reminder tests plus the joint file)

Killed: filter disabled (3 tests); filter also forwarding frames (double delivery, 2 tests); host double-notify of the reminder route; dropping `reminder_fired` from the allowlist (6 joint tests); dropping `reminder_expired` (joint expiry test); unknown reason coerced; defect log on every reason.

Survived (4, same on alpha 4dad65e for the first two, which I re-ran there):
- removing the whole `reminder_changed` row validation (`id`, `channel === params.channel`, `schedule.at` string);
- removing only the channel-equality part of it;
- removing the required-string-field check for fired/cancelled/expired frames;
- removing the adapter-level `routines_unavailable` throw (the service refuses first).
These are pre-existing test gaps (the runtime checks themselves are intact and unchanged). Suggest one table-driven test feeding `reminderNotification` frames with a missing or non-string required field and a row whose `channel` differs from the frame's, expecting `undefined`; and one adapter test with a routine-shaped journal entry expecting `routines_unavailable`.

## Result

Nothing needs to change in b2b4fbe for the R9 merge; the optional tests above can be added in R9.
