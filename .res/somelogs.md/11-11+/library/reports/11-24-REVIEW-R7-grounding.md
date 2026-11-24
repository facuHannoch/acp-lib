# Review: R7 Part 1 grounding report (ced1eff on `reminders-r7`)

Reviewer: clad2a-s. Read via `git show`. Baseline verified on a clean `git archive` of `f0eb7d8` with `TMPDIR` on `/dev/shm`.
Checked against plan revision 5 + addenda, the brief and the spec. No `src/` edits.

Verdict: **approve with 3 required corrections before the Part 2 tests are written, and 2 amendments to the provisional rulings.**
The structure is sound. The gaps are in details the Step 1 tests will otherwise bake in.

## Verified claims

- Protected-file baselines match exactly: agent-session 4,491; native/host 909; controller 764; client 1,046; conversation-manager 1,012;
  agent 563; metering/engine 1,034; native/controller 599.
- Schema is 21 today (`sqlite-schema.ts:5`); the migration accepts 8..21. `PersistenceCapabilities`/`PersistenceScope` carry `channels`/`channels?`
  (`backend.ts:792,819`), so a sibling `reminders` flag and `reminders?` fit the existing pattern.
- Host claims hold: `ensureStarted` shares `#starting`, `restart()` resets failure, `session/open` or `session/create` (not `session/load`),
  `#reopen` budget default 3 in 60 s, `Agent.close()` calls `manager.stopAll()` first (`agent.ts:486`).
- `deleteConversationWithChannel` (`agent/native-channel-lifecycle.ts`) only opens a transaction when `capabilities.channels`; otherwise it runs
  `remove(persistence)` on the root. The report's "including when a custom backend exposes reminders without channels" is a real gap in the
  current code, not a nicety: a reminders-only backend would delete the conversation and leave journal/cache rows. Needs its own test.
  That file is not protected, so the extraction is cheap.
- ACP capability: `Controller.conversationCapabilities` delegates to `conversationCapabilitiesOf` (`conversation-controller/capabilities.ts`), so
  "no expected edit to controller.ts" is plausible.
- Error reasons list matches the plan (`invalid_policy`, `channel_missing`, `channel_retired`, `invalid_schedule`, `limit_exceeded`, `conflict`, `not_found`).
  Treating a stale-version refusal as a client defect is consistent with plan addendum 2.

## Baseline claim: typecheck OK, 35 snapshots OK, but the test count is not the repo's suite

- `tsc --noEmit` on the `f0eb7d8` archive: exit 0.
- `bun test ./test/` reproduces the report exactly: **1,679 tests in 162 files** (119.7 s), 0 fail, 35 snapshots.
- But the project's own gate (`package.json`: `"test": "bun test"`, `"check"`) runs **2,070 tests in 214 files** (143.7 s), 0 fail, 35 snapshots.
  The difference is the 52 `src/**/*.test.ts` files (391 tests) that the report's invocation skipped.
- **Correction:** state the baseline as 2,070/214 for the full suite and use plain `bun test` in the R7 gate (otherwise a regression in
  `src/` colocated tests, which include the persistence and native units R7 will touch, would go unseen). The 35 snapshots are the same either way.

## Required corrections to the design (Part 2 must follow)

1. **Wake eligibility must include `maybe_sent` create/edit entries, not only `pending`.** The report derives the effective wake from "locally eligible pending
   create/edit deadline". If the process dies after an entry is marked `maybe_sent` but before the outcome is recorded, the harness's reported `nextDueAt`
   may not include that reminder (it may never have been applied), and the harness is stopped, so nothing fires. Plan step 1 says "eligible deadlines of
   pending create or edit entries"; a possibly-sent unresolved entry still needs a replay start. Add a test: crash between mark and ack leaves a wake at the
   entry's deadline. Blocked entries stay excluded (no automatic resend), as the report says.
2. **Reminder ID allocation is not stated.** Crash-retry (same `changeId` twice, same `reminderId`) requires the id to be allocated by acp-client at
   acceptance and journaled in the same transaction; the wire already keys outcomes by (`reminderId`, `changeId`) and an offline create has no harness to
   mint one. Say so, and say the id is generated once and persisted with the first change. Also state the allocator is per reminder and the high-water
   survives clearing and `discardBlocked` (the report covers clearing; add discard and coalesced-away ids: gaps are fine, reuse is not).
3. **Wake-index revision fence: define the equal-revision and reset cases.** The report covers "older" and "duplicate revision and value". Missing:
   (a) same revision with a different value (treat as ignored plus a diagnostic, never an overwrite); (b) whether the revision scope survives a harness
   restart or a new session. If the harness's counter can restart lower, a strict fence would permanently reject every later `nextDueAt`
   (wake stuck on a stale value, or never armed). Ask haurness-l via core-p for the revision's scope/monotonicity across process restarts before
   freezing the repository API; until then keep the fence in one function with a documented reset hook, and add a test for "newer-looking value after restart".
4. **Memory implementation vs `reminders_unavailable`.** The report says an offline mutation without a durable repository is refused and a memory
   fallback must not bypass it; the brief gives `reminders_unavailable` = harness stopped AND no `reminders?`. Since a memory repository *is* a `reminders?`,
   the capability needs a `durable` bit (SQLite true, memory false), and the stopped-create refusal must test that bit. Add a test with the memory
   repository: stopped create is refused with `reminders_unavailable`; live path works.

## The four provisional rulings

1. **Offline cron journaled, no provisional wake, grace stored as a duration for routines.** Mostly sound, with two caveats.
   - Grace as a duration is fine for routines because the window is per occurrence. But the default for `cron` is "2x the interval", and a cron
     interval is variable and not computable locally. The ruling must say what is stored for an omitted `expiresAfter` on cron: either a marker
     "harness default" (then the resolved value is not stored at acceptance, a deliberate exception to "never recomputed on resend" that should be
     written down, and tested as such) or a locally resolved duration from a stated rule (for example the 24 h upper clamp). I recommend the marker,
     explicitly named, because the harness advertises the defaults and the variable-interval case is left to contract review.
   - "No provisional wake" leaves an offline-created cron reminder with nothing to start the harness until some other trigger. A cheap fix that does
     not need a calendar evaluator: a *validation wake* at acceptance + the one-shot minimum (2 min) for any cron change still `pending`/unconfirmed;
     once the harness validates and reports `nextDueAt`, the real wake takes over, and a `blocked: invalid_schedule` removes it. Without it, a cron
     reminder created while stopped is invisible to the wake until the next manual start.
2. **Implicit `every` startAt = acceptance + one interval.** Sound. It always satisfies the 2-minute lead (interval >= 10 min), is absolute, resolved once,
   and does not depend on a harness default because acp-client always sends an absolute `startAt`. Record it as acp-client's rule in the adapter so Gate 1 cannot
   silently change it for resends (resends keep the stored value).
3. **Schedule or explicit-expiry edits re-anchor at that edit's acceptance; text/pause/resume/retry never do.** Sound, plus three clarifications to put in the
   brief for cod2a:
   - A schedule edit with `expiresAfter` omitted must keep the previous expiry *policy* (omitted/default, duration, or `null`) and re-resolve it against
     the new schedule; it must not reset a `null` or an explicit duration to the default. So the change stores the policy next to the resolved absolute value.
   - A coalesced never-sent create+edit takes the edit's acceptance time for the lead check and the grace, since the entry is still mutable.
   - Resume does not re-run the 2-minute lead check (a resumed one-shot may already be late; the harness decides `expired`); pause/resume of an overdue one-shot
     must still never change the stored expiry.
4. **Durable per-conversation `suspended` input defaulting to eligible.** The default is the safe side (an extra start, not a lost reminder), so it is sound
   in principle, but it creates the loop plan step 8 forbids unless the input is kept current: if the harness starts for an eligible deadline, finds the channel
   suspended, and the local flag is still "eligible", the wake fires again at once. Requirements: the flag is written in the same transaction as the channel
   suspend/resume intent (and from the open's outcome), `retired`/deleted clears the conversation's contribution, and there is a test where a suspended
   conversation's pending change produces no effective wake while the reported value is unaffected. Name the owner of that write in R7 (the repository setter) even
   though the caller wiring is R8.

## Smaller notes

- `reconcile a receipt by exact ID` vs plan "clear only the newest sent changeId": say that an `applied` for an older id updates the cache but clears nothing
  while a newer sent entry exists. Add the case to the clear-only-newest tests.
- Blocked entries are never-sent-immutable (they were sent), so coalescing must not merge a new edit into a `blocked` entry; the correction is a new entry
  with a higher id. One explicit test.
- Report text says the repository goes "beside `ChannelPersistence` in `src/persistence/channels.ts`" and also "a separate `reminders.ts`". Use the separate file only.
- Cap counting (20 routines per channel) is advisory locally, authoritative at the harness (`limit_exceeded`); say so, so a stale cache cannot block a valid create.
- Part 2 gate wording: use `bun test` (not `bun test ./test/`), 2,070/214 baseline, and re-hash the characterization snapshots.
