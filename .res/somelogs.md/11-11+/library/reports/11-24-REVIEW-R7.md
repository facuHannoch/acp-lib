# Review: R7 Part 2, reminders library side (`reminders-r7` at 6a2a4ea; commits 1a5dd5f, 6a2a4ea)

Reviewer: clad2a-s. Clean `git archive` of 6a2a4ea on `/dev/shm`; no `src/` edits; mutations ran on a separate copy.
Checked against the brief, plan rev 5 + addenda, and my grounding review (02945d1).

Verdict: **do not approve yet.** The design matches the rulings and the code is mostly sound, but four ruled behaviours have no test that would
catch their removal (proven by mutation), the events requirement is untested, and there are 3 real defects/deviations to fix or rule on. All fixable in a
small follow-up with no redesign.

## Gate (my run)

- `tsc --noEmit`: exit 0.
- Plain `bun test`: **2,081 pass / 0 fail, 215 files, 35 snapshots**, matches cod2b (baseline 2,070/214 + the new 11-test file). No `.snap` file changed.
- New file `src/native/reminders/reminders.test.ts`: 11 tests; whole file 20x green; **each test 20x in isolation (`-t`) green, 11 x 20 = 220 runs, 0 failures**.
- Protected files, lines: agent-session 4,490 (-1), host 909, controller 764, client 1,046, conversation-manager 1,012, agent 563, engine 1,034,
  native/controller 590 (-9). None grew. (`protocolMethod` and the native capability builder were extracted first, as asked.)

## Rulings and corrections: implemented?

| Item | Code | Test |
|---|---|---|
| Wake includes `maybe_sent` | yes (`reminder-wake.ts`) | **no** (M1 survives) |
| Validation wake acceptedAt + 2 min | yes, but see Finding 2 | yes (cron and one-shot) |
| Client-allocated `reminderId` + high-water | `randomUUID()` in `create`; `highWater` survives ack/discard/cancel-of-create | yes |
| Fence session-keyed, equal-revision mismatch, open doesn't reset | yes (`compareReminderDeadline`) | yes (stale/mismatch/replace) |
| Memory `durable:false` + `reminders_unavailable` | yes | yes |
| Reminders-only delete in the same transaction | yes (`remove()` + `transaction(remove)`) | partly (fake persistence, see Gap 5) |
| `acceptedAt` immutable, byte-identical resend | yes | yes (`JSON.stringify` equality) |
| Offline cron `harness_default` marker, no `expiresAfter` on wire | yes | yes |
| Edit keeps expiry policy; resume skips lead | yes | partly (duration policy only, M19 survives) |
| Suspended setter in the channel transaction | yes (`protectPendingRetirement` desire + confirm) | **no** (M17, M18 survive) |
| Limits in one config | yes (`limits.ts`, `AgentConfig.reminders.limits`) | boundaries yes |

## Mutation results (11-test file; a survivor = requirement with no test)

Killed (14): coalesce-into-maybe_sent, ack-clears-all, no stale fence, equal-revision mismatch ignored, policy reset to default on a schedule edit, delete
skipping reminders, memory durable, lead `<` to `<=` (8 tests fail), cap `>=` to `>`, suspended removed from wake, blocked kept in wake, cancel of a never-sent
create not dropped, high-water reuse.

**Survived (5): these are gaps, not just nits**
- **M1** drop `maybe_sent` from the wake candidates: 11/11 pass. The crash-between-mark-and-ack correction I required has no test.
- **M12** remove the `paused` exclusion from the wake: 11/11 pass.
- **M17** remove `setConversationSuspended` from the channel `desire` transaction, and **M18** remove it from `confirmChange`: 11/11 pass. The "no-loop test"
  the brief and the rulings call for exists only at repository level (`setConversationSuspended` called directly); nothing proves the channel transaction
  writes the flag, which is the whole point of the ruling.
- **M19** recompute the expiry on every edit (`const expiry = true`): 11/11 pass. The "resume/text edit/retry never re-anchor" test uses an explicit
  60 s duration, which does not depend on the acceptance time, so a `default`-policy reminder resumed late would drift undetected. Needs a test with
  a default policy (and a text-only edit) where `acceptedAt` has advanced.

## Findings (code)

1. **Test coverage of events is zero.** Every test passes `() => {}` as `emit`; created/changed/confirmed/blocked/cancelled are never asserted, nor that they are
   emitted after the transaction commits (they are emitted after `transact`, good, but unproven). The `AgentConversation.reminders` accessor, native
   `conversationCapabilities.reminders === true`, and the typed ACP error through a real conversation are also untested (only the ACP `false` fixtures changed).
2. **Validation wake dominates every schedule (deviation, needs a ruling).** `deriveReminderWake` uses `min(acceptedAt + 2 min, dueAt)`, and a valid `dueAt` is
   always >= acceptedAt + 2 min, so for every pending or maybe_sent create/edit (not only cron) the local wake is acceptedAt + 2 min and the due time is never used
   (the `dueAt` branch is dead except for an explicit past `startAt`). Plan step 1 says "eligible deadlines of pending create or edit entries"; my grounding
   review asked for the validation wake for cron only. Consequences: every offline create starts the harness once at +2 min (probably acceptable and arguably
   safer), but an entry the harness leaves unresolved (failed start, no outcome yet) keeps a wake in the past, which R8 must backoff against or it loops.
   Either rule that this is intended and document it plus an R8 note, or restrict the validation wake to cron/unconfirmed and use the real due time otherwise.
3. **`AgentConversation.reminders` builds a new `ReminderService` (with a fresh in-memory repository) on every access when there is no owner lifecycle**
   (`this.ownerLifecycle?.reminders ?? new ReminderService()`), so state written through one access is invisible to the next. Persisted conversations use the
   Agent's service and are fine; cache the fallback or throw.
4. **Update/pause/resume of an already cancelled (confirmed) reminder is accepted.** `view()` returns the confirmed row with `status: "cancelled"` and `mutate`
   only rejects unknown reminders. It should refuse with `not_found` or `conflict`, and pause/resume of terminal states (`cancelled`, `completed`, `expired`) too.
   A pending/in-flight cancel correctly hides the reminder (`not_found`).
5. **Explicit `every.startAt` is not validated** (past or sooner than the one-shot lead) and a `0` ms explicit expiry is accepted; the first yields an
   expiry already in the past. State whether the harness is the authority (then keep as is, with a test documenting it) or reject locally.

## Gaps and smaller notes

- Upgrade 21 to 22 test is synthetic: it migrates a fresh database, drops the five reminder tables, rewrites `schema_migrations`, and re-migrates; it carries no
  prior data and is not a real older-schema file as the R4 to R6 upgrade tests were. Acceptable only if the tables are the sole schema change; add a check that
  existing conversation rows survive.
- Transactional delete test uses a fake `persistence` (a flag toggled inside a stub `transaction`), so it proves ordering, not atomicity: no SQLite test
  deletes a conversation that has reminders and shows rollback if the conversation delete fails.
- `recompute()` lists every journal (2 queries each + JSON parse) on each write, O(all reminders) per mutation; fine at cap 20 per channel but worth a note for R8.
- A coalesced-away create leaves an empty journal row (high-water only) forever; harmless, but delete it on conversation delete only.
- Equal-revision mismatch is only a return value; nothing records or surfaces it. R8 must log it; say so.
- `AgentSessionEvent` (public union) now includes five `reminder_*` kinds; consumers with exhaustive switches will fail to compile. List it in the release notes.
- The `live` seam is an option of `ReminderService` but not of `AgentConfig`, so R8 will need a binding; in R7 a running harness with no `live` journals as `pending`
  (durable) or throws `reminders_unavailable` (memory), as designed.

## Required before approval

1. Tests that kill M1, M12, M17, M18, M19 (the channel-transaction ones through `protectPendingRetirement` with a real SQLite scope, including the no-loop case:
   suspended conversation, pending change, no effective wake; resume restores it).
2. Event assertions for all five kinds, the accessor, native true and ACP typed error through a real conversation.
3. Fix Findings 3 and 4 with tests; rule on 2 and 5.
