# Re-check: joint follow-up (`joint-r8-rh2` at 5a4b4d5, on top of b01c096)

Reviewer: clad2a-s. Clean `git archive` on `/dev/shm`; no `src/` edits; mutations on a separate copy.

Verdict: **A-D are done and mutation-proven.** One intermittent timeout in an existing joint test needs a look (details at the end); I could not attribute it to this commit.

## Gate and scope

- `tsc --noEmit`: exit 0. Plain `bun test`: **2,148 pass / 0 fail, 223 files, 35 snapshots** (b01c096 was 2,146).
- `src/native-harness/` vs `d9f24b8`: **empty diff**. Ceilings: host **908** (909), native/controller **591** (599), agent-session 4,491; unchanged since b01c096.
- Source changes in this commit: `schedule.ts` (+1), `service.ts` (1 line), `reminder-wake.ts` (+1). Everything else is tests (and an appended note in the conformance report).
- New or changed tests 20x in isolation: production launcher, wall-timer race, malformed legacy wake, unknown-grace edit: **80 runs, 0 failures.**

## Items

**A. Production launch, no `connect`.** The new test (`joint production launcher delivers one fire, deadline update, cache change and notice`) opens the Agent with the rig's launcher only; `rig.launches` shows one `native-harness`
launch, so the host runs `launchNativeConnection` spawning the real harness with our `separateReminderNotifications` filter in front of the approved transport. It wraps `ReminderSync.notification` (where both routes converge)
and asserts exactly one fire and one deadline notification, one `reminder_fired` conversation event, revision 2 / `nextDueAt: null`, cache observation +1 and `completed` with the notice id, and one notice via `reconcileChannel`.
- Filter forwards frames as well as consuming them (double delivery): **killed**.
- `notify` wiring in `launchNativeConnection` removed: **killed**.
- Filter disabled entirely: survives, correctly. The approved harness client then delivers the same frames once through the host's own `onChannelEvent`/`onReminderWake` route, so there is no second delivery.
  That also means that route is dead code while the filter is on; it is the fallback, not a second path.
- Duplicating the host-side route (`onReminderWake` notifying twice, or also calling `#route`): survives, because with the filter on those handlers never see reminder frames. Not a gap in this test.

**B. G4b.** `deriveReminderWake` now skips candidates with non-finite `acceptedAt`, `validationAt` or `dueAt`; the new test creates a valid reminder (wake 1,120,000), then enqueues a malformed legacy entry with a missing anchor (`NaN`) and one with a string `at`,
and the wake stays 1,120,000.
- Removing the whole finite check: **killed**. Removing the anchor/validation check only: **killed**.
- Removing the `Number.isSafeInteger(schedule.at)` guard, or the `dueAt` finite check, alone: survive. They are layered (the string `at` is caught by the other guard), so each malformed shape is covered by at least one layer; removing both together is covered by the first result.

**C. D3b.** Unknown-policy rows now resolve to `{ kind: "harness_default" }` (`resolveReminderExpiry`); the service no longer returns `null` for them. The test asserts the marker and that the staged wire still has no `expiresAfter`. Mutation back to `null`: **killed**.

**D. Cold timer map empty right after the running start.** The race test now asserts `clock.delays` is `[]` immediately after `host.start()` (reported `nextDueAt` is set at that point). With both supervisor guards removed (arm while running),
the race test and the production-launcher test **fail** (2 tests); eligibility alone also fails them. Killed at the joint level.

## Intermittent failure to look at (not attributable to this commit)

In my repeats of the whole joint file (all ten-plus tests together) one run failed in 20, and one in a later 90-run three-way-parallel batch: both times `joint cold wake survives stop and owner close and fires exactly once on the original channel`,
`error: timed out waiting for condition` (the unlabelled `until`, 13.5 s). The test is unchanged by this commit, the isolated test passed 20/20 and 160/160 under 4x load, a further 120 whole-file runs (4 parallel) and 40 serial runs had no failure,
and the previous head b01c096 had 0 of 110 whole-file runs failing (90 of them in the same parallel pattern). That is about 2 in 290 on the follow-up versus 0 in 110 on the base, which is not enough to say whether this commit changed anything; it could equally be a
slow-machine race that was always there. Suggest labelling the `until` calls in that test so a failure names the step, and running the file under load before the next gate. Reported honestly rather than called clean.
