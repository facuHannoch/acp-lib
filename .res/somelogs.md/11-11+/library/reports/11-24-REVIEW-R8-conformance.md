# Review: R8 Part 1 conformance report (e0caeaa on `reminders-r8`)

Reviewer: clad2a-s. Read via `git show`; code facts checked on a clean `git archive` of `pre-alpha-r7` (`4dc6e79`). Reviewed against decision 0031
(`34969fd` copy), the R8 brief and R7 as built. No `src/` edits.

Verdict: **the mapping is accurate and complete against the brief's Part 1 list; go, conditional on 14 points the report leaves open or gets wrong.**
Items 1-8 must be settled in the first Part 2 commit (or answered by haurness-l through core-p) because they change data shape or can brick/spin the client; 9-14 are
clarifications to carry into the tests.

## Verified

- Baselines: agent-session 4,491, native/host 909, native/controller 590, controller 764, client 1,046, conversation-manager 1,012, agent 563, engine 1,034. Exact.
- R7 facts the report relies on are true: `reminderRequest` sends `conversationId`, `acceptedAt`, `attribution:"host"`, `status`, numeric times on every request; update
  fields are tracked; R7 re-resolves expiry at the edit; `host.ts` open path is `initialize` -> `startupBatch` -> `openOrCreate` -> `acknowledgeOpen`
  (`host.ts:428-449`) with `REQUIRED_METHODS`; a missing `reminders` capability must not become `HarnessIncompatibleError`, which the report respects.
- Part 1 list: create/update/cancel payloads, ms `expiresAfter` (omitted/number/null), expiry from the harness row's `expiresAt`, grace-only edit uses the stored anchor,
  `stale`/`invalid_state`, `reminderLimits` mapping, 30 s-ahead rule, the four events with `reminder_expired` separate, open outcomes + `nextDueAt` + `reminderRevision` +
  first page, batch cap 100, `invalid_cursor`, session-lifetime receipts, offline routine refusal: all mapped.
- Sensible and correct: separate schedule anchor vs retry deadline (and the coalescing rule that a later text edit keeps the earlier schedule's anchor); `done` -> `completed`
  with row lifecycle kept apart from journal status; stage order wire -> timer -> idle stop; legacy R7 `maybe_sent` keeps identity and is re-encoded, never given a fabricated anchor.

## Must settle before code

1. **R7's local cap counts one-offs; 0031 has no one-off cap.** R7 `perChannel: 20` rejects the 21st active/paused reminder locally with `limit_exceeded` (it came from the old
   "20 active *routines* per channel"). 0031 advertises `maxActiveRoutinesPerChannel: 0`. The report says "harness authoritative" but never says the local one-off cap is removed.
   Remove local enforcement for one-offs (keep `limit_exceeded` as a harness block), and delete/adjust the R7 cap test.
2. **Public event schema collides with the wire.** R7 emits `reminder_changed {reminder: ReminderView}` and `reminder_cancelled {reminder}`; 0031 has `reminder_changed {reminder}`
   and `reminder_cancelled {reminderId, by}` under the same kind names. A local mutation will also be echoed by the harness. "Keep local intent notifications distinct from
   duplicate wire echoes" is not a design. Fix one public schema now (kinds, payloads, a `source: "local"|"harness"` discriminator or renamed local kinds, and the rule for the echo
   of an acknowledged local write), because `AgentSessionEvent` is public and R7 already widened it.
3. **The cache cannot hold agent-created reminders.** R7 `reminder_cache.id` is a FOREIGN KEY to `reminder_journals(id)` and lists are derived from journals. Rows that arrive from
   the open's first page, the sweep, or `reminder_changed` for a reminder the host never wrote (`createdBy: "agent"`) have no journal. State the approach (empty journal with
   `highWater 0` is fine and makes later host edits start at changeId 1) or a schema change. The report also lists `persistence/*` as touched but never says whether
   schema 22 changes. Say yes or no. R7's 22 is unreleased; if you amend 22 in place or add 23, an upgrade test from a real file at the prior version is required.
4. **`session/open` can be bricked by one bad entry.** 0031 validates both startup batches before either mutates and rejects the whole open (`invalid_params`) on a bad
   entry, so a single unencodable reminder (legacy R7 shape, strict-payload violation, 101st entry) would block channel changes and the open itself on every start.
   Required: validate each frozen entry locally against the 0031 strict shapes before including it, quarantine anything that fails (visible, with a diagnostic), and never retry
   an open that was rejected for the same batch without changing it. Add a fake-harness test: bad entry quarantined, channels still open.
5. **Past `nextDueAt` while the harness is running must not spin the timer.** The open reports the earliest remaining eligible deadline "even if already past due" and processes
   the rest after the fence releases. A client timer re-armed on that value calls `ensureStarted()` (a no-op while running) and re-arms at once. The report's budget only
   covers failed starts. Arm the cold-wake timer only while the harness is stopped or starting (the running harness owns firing), or apply a delay floor, and test a running
   harness with a past reported deadline.
6. **Negotiated-unsupported must also drop the wake.** If the harness omits `capabilities.reminders`, queued entries are preserved but still produce validation wakes, so the
   supervisor starts a harness that will never accept them, the exact loop the budget exists to stop. Exclude them from the wake (like the routine entries the report already
   excludes) until support appears.
7. **0031 gives rows no version.** The report says an old receipt must not replace a newer observation and keeps R7's `revision`, but the 0031 row has no revision field, and the
   listing revision is internal to cursors. Replayed receipts return the row "as of that receipt" (stale by construction). Define the order rule: one serialized consumer
   per connection; a receipt's row seeds the cache only on the first transition `maybe_sent -> applied` and never over a row already updated by an event or sweep;
   the sweep is authoritative. Add a test with a replayed older receipt after a newer `reminder_changed`.
8. **Default grace on a schedule edit is ambiguous in 0031.** The report says "schedule edits retain prior grace policy, do not synthesize an explicit duration", i.e. omit
   `expiresAfter` so the harness recomputes 2x the new lead. But the row stores an `expiresAfter` number; an omitted patch field may mean "unchanged", which would keep
   the old computed grace. R7's own test pins re-resolution. Ask haurness-l (through core-p) which it is before writing the scripted fake, or the fake will encode
   our assumption and R-H2 will disagree. Same for the coalesced create+edit case.

## Clarifications for the tests

9. **Correcting a blocked create.** A blocked create that never produced a row (`invalid_schedule`, `channel_missing`, `limit_exceeded`) cannot be fixed by `update`
   (`not_found`). 0031 says a higher create with the identical original definition is applied and a changed definition conflicts, which is not mapped in the report.
   Specify the client path (new reminderId vs a higher create on the same id) and ask whether "changed definition" applies when no row exists. Test both identical and changed.
10. **Unmapped 0031 rules to put in the table:** update of a terminal row is a harness `blocked: invalid_state` (the local `conflict` is only a cache-based precheck;
    a stale cache must still produce the blocked receipt, and the local terminal set must exclude the harness `blocked` row state so update/resume of a blocked row is
    allowed); cancel of a terminal known row is `applied` without changing state; inspect-only open lists but has no wake authority (state that the client never uses it).
11. **Session replacement.** The report resets the fence "only on actual session replacement" but does not say how the client detects it. Define it (the open that took
    `session/create` because the session was confirmed absent) and what happens to the journal and cache then: the harness lost all reminders and receipts, so confirmed rows
    must be flagged lost/unreconciled rather than silently kept or re-sent, and `maybe_sent` creates need a stated rule.
12. **Sweep eviction and deletion races.** Say what a complete uninterrupted sweep (same listing revision) does with cached rows the harness no longer returns (flag/evict, never while
    a local entry is unresolved), and what happens when a sweep, `reminder_changed` or `reminder_cancelled {channel_retired}` arrives for a conversation already deleted locally
    (R7 deletes its journals and high-water in the delete transaction): such rows must be ignored, not re-seeded as orphans.
13. **Routine refusal code.** `reminders_unsupported` is also the ACP / no-capability error; use a distinct typed code for "routines disabled" so consumers can tell them apart.
    Explicit grace is now limited to 300000..86400000 locally (R7 allowed any positive value; R7 tests using 60 s must change).
14. **Idle stop vs explicit stop.** `host.stop()` sets `#stopped`, which suppresses automatic reopen. An idle `{stopped:true}` must not set it, and the state after it must be
    the cold-wake "stopped", with waits and approvals handled as the report's "admission/start fence" implies; spell out the race (send arrives between the stop reply and the
    state change) and that every `reminders_due` event is processed before the stop reply is acted on, so the armed wake is current.

## Scope and process notes

- The "harness-only" row proposes client declarations "under `native-harness/src/`". That tree holds the harness client types and in-process harness; confirm with core-p who owns it
  before adding protocol declarations there, so the next harness drop does not overwrite them.
- `host.ts` sits exactly on its 909 ceiling and `controller.ts`/`agent.ts` near theirs: the first commit of Part 2 should be extraction-only with the line counts shown, then the integration.
- Part 2 mutation testing will target: ordering (channel then reminder), exact-receipt replay before high-water, changed-payload conflict, unseen-lower stale, 100-entry chunking, revision
  fence cases, timer clamp/early wake/backward jump, owner-only arming, `ifIdle` window boundary (inclusive), stop racing admission.
