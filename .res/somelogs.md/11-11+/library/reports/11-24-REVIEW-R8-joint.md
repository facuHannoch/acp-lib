# Review: joint real-stdio acceptance (`joint-r8-rh2` at b01c096)

Reviewer: clad2a-s. Clean `git archive` of b01c096 on `/dev/shm`; no `src/` edits; mutations on a separate copy.

Verdict: **approve the joint acceptance.** The ten tests drive the real harness child process and their assertions (revisions, receipts, notice counts, survival of a SIGKILLed harness and owner)
prove the claims they make. Several guards that the R8 unit tests kill are not exercised at the joint level; they are listed with proposed assertions, none blocking.

## (1) Gate

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,146 pass / 0 fail, 223 files, 35 snapshots** (matches cod2b: 2,146/223). No `.snap` change.
- `reminders-joint.test.ts`: whole file **20/20** green (10 tests each time); **each of the 10 tests 20x in isolation: 200 runs, 0 failures.**

## (4) Scope and ceilings

- `src/native-harness/` vs `d9f24b8`: **empty diff.** The only harness-side change in the branch is the approved merge itself.
- Joint-branch changes outside tests: `native/controller.ts` (+1, `if (payload.turnId === undefined) return`), `native/host.ts` (reminder events through the harness client), `native/reminders/wire.ts` (typed entries).
- Protected files: agent-session 4,491; host **908** (ceiling 909); native/controller **591** (ceiling 599); controller 764; client 1,046; conversation-manager 1,012; agent 563; engine 1,034. None above.

## (3) 5fa49cd: our entries versus the harness `ReminderChange` union

`reminderRequest` now returns the harness's own `ReminderChange` (`export type { ReminderChange as WireChange }` from `native-harness/src/client.ts`), built per branch so TypeScript checks each:
create `{ channel, text, schedule:{at}, acceptedAt, expiresAfter?, policyNames? }`; update `{ text?, state?, expiresAfter? }` with `schedule` and `acceptedAt` together or neither
(the harness's `ReminderEdit` intersection); cancel `{}`. The entry shapes match the union exactly and no cast hides a mismatch in the request builder.

What is still not checked by the compiler (low risk, recommended cleanup):
- `reminderRpc` is `client.request(method as never, params as never) as Promise<T>`, so the call sites (`reminder/change`, `/get`, `/list`, `session/stop`) are not type-checked against the harness `ReminderMethods`
  although typed client methods exist (`changeReminder`, `getReminder`, `listReminders`, `stopIfIdle`; the joint test itself uses them).
- `WireReminder`, `WireReceipt`, `ReminderOpenResult`, `ReminderPage` and the event types in `wire.ts` are hand-written copies of the harness `Reminder`, `ReminderChangeResult`, `ReminderOpen`, `ReminderList`, `ReminderChannelEvent`
  (e.g. `blockedReason?: string` where the harness has the closed `ReminderBlockReason` union). Replace them with the harness types so drift fails the typecheck.

## (2) Do the joint tests exercise the real child? Do the assertions prove the claim?

All ten use `spawnHarness`, the real harness CLI (`serve --stdio`) in a Bun child with its own stdio transport, and a real SQLite harness home; no scripted peer. The only seam is the harness's `HARNESS_TEST_REMINDER_TIME`
(a fake clock inside the real child) and a fault hook; the wall-timer test runs with that seam off and the real harness wall clock.

| Test | Claim and why the assertions prove it |
|---|---|
| startup ordering | channel edit applied in the same open as three reminder receipts, in submitted order; harness `reminderRevision` exactly 4; cancelled and edited reminders have no notice (`reconcileChannel` returns none); the created one fires once |
| lost open and replay | real `SIGKILL` after the open is applied but before the reply; both entries `maybe_sent`; replay returns byte-identical receipts and the same revision (1); the journal sequence observed at each acknowledge is `[[1,applied],[2,maybe_sent]]` then `[]` (newest-only clearing); a changed replay payload gets `blocked/conflict`; exactly one notice after the due time |
| missed deadline and killed harness+owner | harness `reminders_due` events dropped; the harness fault kills the child (exit 137) and the owner process is SIGKILLed; the next executable open recovers (revision 3), one notice for the fired reminder, the expired one produces no notice |
| cold wake | one timer after `stop()`, none after `close()`, a new owner re-arms, one launch, one fire, one notice id, `done` row on the original channel |
| wall-timer race | stale cold task invoked exactly at the real harness's own due time: one fire, one launch, final revision 2 / `nextDueAt: null` |
| conditional stop/send race | real harness `stopped:true` committed, a send issued before the host acts waits and shares one restart (launch 2); then a cold wake restarts (launch 3) and the reminder is `done` |
| agent tool | a real agent-tool `schedule_reminder` reaches the conversation event and the cache with highWater 0, survives stop/start |
| offline deletion | no batch entry sent, real harness has no row |
| suspension/resume | held while suspended, no wake, fires after resume with one notice |
| expiry omitted/duration/null | harness-computed `expiresAfter` 360,000 / 300,000 / null; two `reminder_expired`, one fired; notice exists only for the `null` one |

## Mutation results (joint file only)

Killed: newest-only clearing removed; idle-stop send waiting for the stop removed; offline deletion not removing reminders; explicit grace not sent; early reminder events buffered during open dropped; agent-created rows not observed; close not disarming the supervisors.

Survived at the joint level (each is killed by the R8 unit suite, so no coverage loss overall, but the brief called out the first two):
- **Dropping `await reminderSync.settled()` before acting on the stop reply.** The real harness delivers `reminders_due` ahead of the reply but the test never makes the deadline write slow, so the ordering is not at risk. The unit test with a delayed `updateDeadline` is the only proof.
- **Arming the cold wake while the harness is running** (both guards removed in the supervisor). The race test asserts the timer map only at the end; assert `clock.delays` is empty immediately after `host.start()` while a reported `nextDueAt` exists.
- Idle window forced to 0, idle stop setting `#stopped`, no restart budget for wake starts, replacement of the session on every open, resending entries beyond `pending`/`maybe_sent`, a frozen wire re-encoded each time (byte-identical anyway), the local suspended wake exclusion (the harness already reports `null`), the older-revision fence (the real harness never sends one).
- "Let a replay duplicate a notice" cannot be done without editing the harness; the client-side equivalent (replacing the session on every open, or re-sending acknowledged entries) is invisible at the joint level because the harness's exact-receipt replay is idempotent, so notices stay at one. That is the contract working, not a test weakness.

## Path not covered jointly

The joint tests inject `rig.harness.connect`, so the **production launch path is never run against the real harness**: `launchNativeConnection` (spawn of `HARNESS_MAIN`) with our `separateReminderNotifications` filter in front of the approved transport.
The filter is unit-tested and the child-process launch test uses a stub script, but nothing runs the real harness through it. Since the approved harness client now parses reminder events itself, the filter and the host's
own `reminderNotification` handling in `onChannelEvent` are two routes for the same frames. Add one joint test that opens an Agent with no `connect` override and checks one reminder fires with exactly one notice and one deadline update (not two).

## Residuals from my earlier reviews

- **G4b** (guard `Number.isSafeInteger(schedule.at)` and the "valid + malformed legacy keeps the valid wake" assertion): **not fixed** in the joint branch.
- **D3b** (provisional expiry `null` for an unknown-policy reminder after a schedule edit, indistinguishable from "no expiry"): **not fixed** (`service.ts` still sets `expiry` to `null` for `unknown`).
Neither blocks the joint acceptance. Both are small follow-ups.

## Requests (all non-blocking)

1. Add the two joint assertions above (no timer while running; real-harness `reminders_due` ordering with a deliberately slow deadline write if feasible).
2. One joint test through the default launch path (no `connect`).
3. Replace the copied wire types and the `as never` RPC helper with the harness types and typed client methods.
4. Land G4b and D3b.
