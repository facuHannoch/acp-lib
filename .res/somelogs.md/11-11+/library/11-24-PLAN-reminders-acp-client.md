# Plan: reminders, acp-client half

Status: planning only, 2026-11-24 (core-p), revision 5. The user's decisions and the harness's wire contract answers
arrived; this revision folds them in. No code, no briefs sent yet. Grounded in `../11-23-SPEC-reminders-and-routines.md`
(reviews 1 and 2), the harness `0004-DESIGN-reminder-tools/SPEC.md` (an untracked draft in the haurness-l worktree), the
planning answers of 2026-11-24 and the contract answers below, and the code on `integration-r456-status`
(`src/native/host.ts`, `records.ts`, `src/persistence/channels.ts`, SQLite schema 21). The harness contract is still a
draft until Gate 1 freezes it: the open points are listed at the end. Implementer and reviewer for this track are cod2a and
clad2a; Cod1a and Clad1a stay on the native harness tool gates.

## Decisions (the user, 2026-11-24)

- Spec defaults confirmed: coalesce missed runs, skip on overlap, 5-minute harness and 15-minute consumer minimum interval,
  20 per channel. Reminder text is stored in the clear.
- Only the SQLite owner arms the wake timer.
- `stop()` of the harness only keeps the wake armed (stopping to save resources is the idle-stop case and the reminders are
  still wanted). `agent.close()` clears the timer; the stored wake time remains and the timer is set again when the Agent next
  starts. To silence reminders the consumer suspends the session or the channel, which removes them from the next due time.
- Creating a reminder while the harness is stopped on a backend without the repository: REFUSE with a typed error
  `reminders_unavailable`, saying the harness must be running or the backend needs the repository (starting the harness inside
  `create` would add a second, slower and failable behaviour; custom backends without the repository are rare).
- `expiresAfter` is an optional field on the create tool of the agent AND on the consumer API: omitted, the defaults apply; a
  duration sets its own window; `null` means always deliver and tell the agent how late it is ("remind me before the 3pm
  meeting" expires at 3pm; "check the deploy in 10 minutes" expires quickly). This replaces my 30-second late-wake tolerance
  proposal: lateness is judged per reminder by the harness, not by a fixed host number.

## The harness wire contract (answers received 2026-11-24; draft until Gate 1)

1. **Where changes travel:** inside the open, next to `channelChanges`: a `reminderChanges` field on the session create and
   open requests, applied AFTER the channel changes and BEFORE recovered or due work (a cancel made while stopped must land
   before a past-due reminder fires at open). The same cutoff rule as channel changes: after the open, changes go through the
   live reminder requests.
2. **Changes, results, reasons** (mirrors decision 0020): an entry `{ reminderId, changeId, op: create | update | cancel,
   payload }`, `changeId` being acp-client's version, echoed back; a result `{ reminderId, changeId, outcome: applied |
   blocked, reason? }`; blocked reasons `invalid_policy`, `channel_missing`, `channel_retired`, `invalid_schedule`,
   `limit_exceeded`, `conflict`. A create repeated with the same id and payload is `applied` and returns the existing
   reminder; the same id with a different payload is `blocked: conflict`; a cancel of something cancelled or finished is
   `applied`; an update of something unknown is `blocked: not_found`. A malformed batch is rejected whole before anything
   applies; otherwise each entry stands alone.
3. **Next due time:** one session-wide value `nextDueAt: string | null` (ISO UTC, leaving out suspended channels), in the open's
   response and in a session event `reminders_due { nextDueAt, revision }` emitted whenever it changes; not per channel.
4. **Events, no replay on open:** `reminder_fired { reminderId, occurrenceId, scheduledAt, firedAt, noticeId, missed? }`,
   `reminder_cancelled { reminderId, by: host | agent | channel_retired | completed }`, `reminder_changed { reminder }` (a
   create, an edit, a pause or a resume). The open's view carries each reminder's current state (state, lastRunAt, last
   occurrence) and acp-client compares it with its cache; what a missed fire produced is already in the recovery view's turns
   and items.
5. **Idle stop:** one atomic call `session/stop { ifIdle: true, unlessDueWithinMs? }`, returning `{ stopped: boolean }`: the
   harness checks idle (no running turn, nothing waiting in an inbox, no pending approval) and that no reminder is due within
   the window, then stops, in one step; any failed check changes nothing. acp-client passes the window (it knows the startup
   time); the harness owns the idle check.
6. **Limits:** refusals are `blocked: limit_exceeded` on a change; on a live request, a typed error with the same code.
   acp-client's stricter local check usually fires first.
7. **Capability:** one flag, `capabilities.reminders: true` in `initialize` (covers the requests, the events and
   `reminderChanges` at open); acp-client's consumer flag stays `conversationCapabilities.reminders`.
8. **Schedules:** absolute only on the wire: `{ at }`, `{ every, startAt }`, `{ cron, timezone }`. The public API accepts `in`
   and acp-client converts before sending; the agent's own tools accept `in` and the harness converts; a host request carrying
   `in` gets `invalid_schedule`.

Earlier planning answers still holding: the reconcile list is bounded and restartable (opaque session- and scope-bound
cursors, ordered by reminder id, a revision fence, an explicit cursor-invalidated response; the wake never depends on it);
host writes are attributed to the host and only optional consumer-supplied additional `policyNames` are forwarded (an
unknown name is a recorded `blocked: invalid_policy`, no mutation; narrower consumer authorization is applied by acp-client
BEFORE recording anything); an `every` without `startAt` gets an absolute `startAt` resolved once at acceptance, live or
stopped; the harness retains recorded outcomes for the session lifetime (no silent expiry); no acp-client open is
inspect-only (a stopped session is read from the cache plus pending changes); event replay is not assumed; the harness's
accepted crash window (it commits before acp-client persists the wake) stays documented.

## What changed from revision 4

1. The wire is now concrete: `reminderChanges` with `{ reminderId, changeId, op, payload }`, per-reminder versions echoed back,
   outcomes `applied | blocked` with the listed reasons.
2. The store mirrors decision 0020's shape, not an intent log with free ids: a per-reminder ordered sequence of entries with a
   strictly increasing `changeId`. A sent entry is IMMUTABLE: because a create with the same id but a different payload is a
   `conflict`, an edit of a reminder whose create MAY have been sent is a NEW `update` entry with a higher `changeId`, never a
   merge into the create; only never-sent entries may be merged. An acknowledgement clears an entry only if its `changeId` is
   the newest sent for that reminder.
3. Reconcile is primarily the open's view of each reminder's current state compared with the cache; the paged sweep remains
   for completeness and under a bounded restart budget.
4. The late-wake tolerance is gone: `expiresAfter` per reminder decides lateness.
5. Idle stop is unblocked at the contract level (`session/stop { ifIdle, unlessDueWithinMs }`).
6. `create` while the harness is stopped without the repository: typed error `reminders_unavailable`.
7. The wake value comes from the open's `nextDueAt` and the `reminders_due` event with their revision; acp-client's effective
   wake = min(that value, the eligible deadline of any pending create or edit).

## What exists to build on

- Open sequence: `host.ts #open` runs `initialize`, then `startupBatch()` (pending channel changes from the durable `channels?`
  repository), then `openOrCreate(..., batch)`, then `acknowledgeOpen`. `reminderChanges` ride the same open, after the channel
  changes.
- `ChannelPersistence` is the pattern: a coalesced desire, a version as the wire id, clear only the confirmed version, one
  transaction with the conversation write; the reminder store adds immutability of sent entries.
- Lazy start: `ensureStarted()` is single-flight; `agent.harness.start()` exists. A wake calls it.
- Not built: any host-owned timer, `idleStopMs` for the native host (the only `idleStopMs` today is the orchestrator pool's),
  `conversationCapabilities.reminders`, the reminder wire.

## Pieces and order

Every step ends with the full suite (RAM-backed `TMPDIR`), new tests about 20x in isolation, a clean-copy gate and clad2a
review. Steps 0-2 touch the wire only through one adapter file.

**Step 0: grounding and decisions.** A report only: host start/stop paths; where the timer and wake index belong (host vs
`src/native/reminders/`); the store shape; the open's reminder view size and paging; how pause and resume travel (see
questions); the typed errors (`reminders_unavailable`, the blocked reasons); how `expiresAfter` flows on both APIs. Gate:
report reviewed.

**Step 1: durable store and wake index (no timers, no wire).** A `reminders?` repository with `capabilities.reminders`
(schema 22), transaction-scoped like `channels?`: (a) `reminder_changes`: per reminder, ordered entries `{ changeId, op,
payload, state: pending | maybe_sent | applied | blocked(reason) }`, `changeId` strictly increasing per reminder, an entry
immutable once `maybe_sent` (mark it before a send); coalescing only among never-sent entries (a cancel supersedes a never-sent
create or update and nets to nothing); an acknowledgement clears an entry only for the newest sent `changeId`; a recorded
`blocked` outcome stops the resend but stays visible with its reason until corrected (a new entry, a higher `changeId`) or
discarded; no unresolved entry is ever expired locally; (b) `reminder_cache`: last-confirmed reminders per conversation (id,
schedule, text, state, next run, revision, last run); (c) `wake_index`: one row per Agent: the reported `nextDueAt` and its
revision plus the derived effective wake (min of that and the eligible deadlines of pending create or edit entries; none for a
cancel, a pause, a suspended or retiring target). An older revision never replaces a newer one. A conversation delete removes
its entries and cache rows in the same transaction. SQLite schema 22 with an upgrade test from 21; the memory implementation for
backends without it (no durable changes, no wake across a restart; creating while stopped is refused with
`reminders_unavailable`). Gate: repository tests (the coalescing table, freeze after `maybe_sent`, an edit after a possibly-sent
create becomes an update, clear-only-newest, older-revision rejection, wake recompute, transactional delete), the upgrade test.

**Step 2: local validation and the library model.** `Reminder` type; `conversation.reminders` (create, get, list, update, pause,
resume, cancel, `discardBlocked`), `agent.reminders.list()` (paged); `conversationCapabilities.reminders` (true native, false
ACP: a typed error). Local validation before any write: schedule syntax (`at`, `every`, `cron` with timezone; `in` converted to an
absolute `at` at acceptance, live or stopped; an `every` without `startAt` gets one resolved at acceptance), the 15-minute
consumer minimum for repeating schedules, `expiresAfter` (omitted, a duration, or `null`), narrower consumer authorization and any
optional additional policy names (host writes are attributed to the host; the channel policy is never copied), typed errors for
limits and for `reminders_unavailable`. Harness-running path: a live request, done on confirmation; harness-stopped path (with
the repository): a change plus the wake index in one transaction, `state: "pending"`. Events (created, fired, changed,
confirmed, blocked, cancelled) on the existing conversation event path, deduplicating fires by notice id. Lists with the
harness stopped: cache plus pending; blocked stay listed. Gate: unit tests against a fake harness client; a crash-retry test (the
same `changeId` twice gives one reminder; a changed payload under the same id is a conflict, not an overwrite).

**Step 3: startup ordering, confirmation and reconcile.** In `#open`, after `startupBatch`, in the same open request: send
`reminderChanges`, each marked `maybe_sent` first. Order held and tested: channel changes, then reminder changes, then due work,
then the open fence. A reminder for a conversation retired in the same batch comes back `blocked: channel_retired`; one for a
channel suspended in the same batch is held; an offline cancel or pause beats an overdue occurrence. Outcomes by
`reminderId` + `changeId`: `applied` clears (newest only); `blocked` is recorded and stays visible; `conflict` is surfaced as a
defect; `nextDueAt` and its revision update the wake index only if newer. After the open, reconcile: compare the open's
per-reminder current state with the cache; run the bounded, restartable paged sweep when the view is not complete (cursor
invalidated: restart within a budget, then keep the cache last-confirmed, flagged unreconciled); the sweep never feeds the wake.
A crash between the harness applying and acp-client clearing: the resend returns the recorded outcome (a real stdio restart
test: the draft's "replay after a lost open response"). Every acp-client open is executable: a stopped session is never opened
just to read it. Gate: ordering tests with a scripted fake harness for each interleaving; sweep tests (an invalidated sweep
restarts within its budget, a cursor from another scope is rejected); real-stdio restart tests when the harness side exists.

**Step 4: wake timer, stop and close.** A host-owned timer, armed only by the SQLite owner, from the wake index; at expiry
`ensureStarted()` (single-flight with any other start; the cancellable start and `harness_unresponsive` unchanged); opening is
enough, no wake request; a running harness has its own timer. Rearm on every index change; `harness.stop()` keeps the wake
armed; `agent.close()` clears the timer and the stored wake remains; rebuilt at Agent construction (an overdue index starts the
harness once, at once). A failed wake start retries on the existing restart budget (3 in 60 s), then the index stays and
`HarnessUnavailableError` surfaces; it must not spin. Lateness is the harness's per-reminder `expiresAfter` outcome (no host
tolerance number); the accepted crash window and the cold-start delay are documented; a missed `reminders_due` event is repaired
by the open response and the reconcile. Injectable clock. Gate: fake-clock tests (fire, rearm, race with a manual `start()`, race
with `close()`, `stop()` keeping the wake, overdue at construction, a failed start does not loop, an older revision after a
newer one, only the owner arms).

**Step 5: idle stop.** `harness.idleStopMs` (off by default). Stop through the atomic call `session/stop { ifIdle: true,
unlessDueWithinMs }` with the window (about twice the measured startup time, with a floor and a ceiling, configurable); acp-client
also requires no turn running or held on its side, no pending permission, no held channel or reminder change; `{ stopped: false }`
changes nothing. After a stop, arm the wake for the next due time; activity starts the harness again, racing the stop safely
(started once). Gate: fake-harness tests for each non-idle reason, the window boundary, stop then wake, stop racing a send.

**Step 6: routines on the library side** (the draft's step 3, after the routine decisions): routine options on the model, the
15-minute minimum, update, pause and resume changes with the freeze rule, the catch-up counters from the harness; no schedule
computation in acp-client beyond the local minimum check and the wake value. Enabling consumer routines is gated on the harness's
unattended-turn guard.

**Step 7: real-stdio joint acceptance** (with the harness implementation; a live provider only with the user's approval, otherwise
the deterministic fixture model):
1. Stop a harness holding a saved reminder: no process runs; the wake starts it once; one notice to the original channel;
   `reminder_fired` once; the list shows it done.
2. Cancel an overdue reminder while stopped: zero notices on open.
3. Offline create, cancel and update of different reminders in one open, each confirmed by `changeId`; none duplicated after a kill
   between apply and clear (the lost open response).
4. A missed `reminders_due` event: the open response and the reconcile repair the wake.
5. The accepted crash window: the harness commits and advances, acp-client dies before persisting the wake; the next eligible open
   recovers it, late (or expired by `expiresAfter`); assert the documented behaviour.
6. Delete a conversation with an offline pending reminder: nothing fires, the cache is clean.
7. Overdue at open after downtime: fires once (coalesced for a routine), unless it expired.
8. A suspended channel: held, excluded from the wake, no wake loop, no idle-stop restart loop; resume runs it.
9. Idle stop with a reminder far away: stops and wakes at the due time; with one inside the window the atomic stop refuses.
10. A wake racing the harness's own timer: one firing.
11. An agent-created reminder (a tool call in a turn): appears via `reminder_changed`, in the cache after the next open, and wakes
    after an idle stop.
12. `expiresAfter`: omitted (the default), a duration, and `null` (delivered late with its lateness told to the agent).
13. `harness.stop()` keeps the wake armed; `agent.close()` clears it and a new Agent re-arms it from the stored time.
Gate: the real-stdio file passing 20x, plus the suite.

**Step 8: documentation** (library guide; the spec's open item resolved; limitations kept: wakes only while acp-client runs; the
narrow crash window; the cold-start delay; the cache is last-confirmed state; `reminders_unavailable`).

Suggested slicing for briefs: R7 = steps 0-2 (store, model, validation: harness-free), R8 = steps 3-5 (wire, timer, idle), R9 =
steps 6-8. Nothing starts until the user schedules it.

## Resolved by haurness-l (revision 5 answers, checked against alpha d788621) and what stays for Gate 1

Resolved at planning level (the contract is still frozen only at Gate 1):
1. **Methods:** `session/create` and `session/open` carry `reminderChanges`; `session/load` was stale spec wording.
2. **Replay:** outcomes are keyed by (`reminderId`, `changeId`); the recorded id is checked first: identical returns the recorded
   outcome; a changed payload is `blocked: conflict` with no replacement; an UNRECORDED LOWER version gets an explicit stale
   refusal with no mutation, never an applied acknowledgement. acp-client must therefore treat a stale refusal as a defect
   (it never sends a lower id than one it recorded as sent). Exact code and high-water rules: Gate 1.
3. **Pause and resume:** `update` payloads expressing desired paused or active state; field spelling: Gate 1.
4. **Reasons and expiry:** alpha already has `blocked: not_found` for an unknown update. Proposed expiry: a finite window elapsed
   gives a terminal `expired` state with NO notice and NO fired event; `null` permits late delivery with its lateness; omitted
   uses defaults (durations still open). Representation and event: Gate 1. Plan impact: acp-client shows `expired` as a terminal
   state from the list and cache, not from an event it must wait for.
5. **Revision:** the executable open carries the revision associated with `nextDueAt` (the open revision is reused only if both
   reflect the same committed state).
6. **Bounded open:** the open returns intent outcomes and wake state only; reminder records are reconciled through the bounded
   list, and turns and items through the existing scoped reads. This CORRECTS my plan wording "open's view of each reminder":
   steps 1 and 3 reconcile by the paged list (revision-bound cursors), not from an inline snapshot.
7. **Unattended guard:** a separate negotiated capability is required for consumer routines; base reminders support alone does
   not enable routines (step 6 gate). Exact flag: contract review.
8. **Repository:** a dedicated optional `reminders?` repository is right; the stopped-create refusal depends on its absence, not
   on `channels?`. Schema 22 is coordinated on this track.
9. **Sweep and retention:** Gate 1 pins the cap, TTL and code; the design default is revision-bound cursors and session-lifetime
   intent receipt retention.

Plan consequence (revision 5 text to read with this section): wherever steps 1, 3 and 7 say the open's per-reminder view is
compared with the cache, read it as the bounded list sweep after the open; the open itself only supplies outcomes, `nextDueAt`
and its revision.

Pending with the user: the idle-window floor (per Agent or global); whether the 15-minute consumer minimum applies to
agent-created routines; the `expiresAfter` default durations; whether to schedule R7.

## User decisions, round 3 (2026-11-24)

- **Idle-stop window:** a setting per Agent (`harness.idleStopWindowMs`), overridable per conversation. The atomic stop passes the
  largest window among conversations that have a reminder pending, so a conversation can only keep the harness up longer for
  itself; the call itself still carries one value. Floor and ceiling remain (defaults to be set in step 5).
- **Default `expiresAfter` (proposal, needs harness agreement):** the grace after the scheduled instant is twice the lead time
  (creation to scheduled instant), capped at 1 day: 5 min lead gives 10 min, 1 hour gives 2 hours, 12 hours or more gives 1 day.
  Resolved to an absolute expiry at creation. For repeating schedules the lead is the interval, per occurrence. Open: a floor for
  very short leads; whether the window is counted from the scheduled instant (assumed) or from creation.
- **Minimum interval:** question raised whether the 15-minute consumer minimum covers agent-created routines, and whether the
  harness should provide it to acp-client. Recommendation recorded in the reply; pending the user's answer.

## User decision, round 4 (2026-11-24): one set of minimums for everyone

Supersedes the 5-minute harness and 15-minute consumer minimums (and the question whether the consumer minimum covers agent
routines): the same limits apply to the agent tools and the consumer API.
- **One-shot** (`at`, or `in` converted to `at`): the scheduled instant must be at least 2 minutes after acceptance.
- **Repeating** (`every`, `cron`): the interval between consecutive runs must be at least 10 minutes.
- The two are told apart by schedule shape. `every` is checked locally by acp-client (its interval). `cron` needs the gap between
  consecutive fires, which acp-client does not compute (no schedule computation here), so the harness checks it and returns
  `blocked: invalid_schedule` (a typed error on a live request). The harness advertises both numbers in `initialize` so acp-client
  does not hardcode them; if the harness does not advertise them, acp-client does not check, and the harness refuses.
- With the doubling `expiresAfter` default, a 2-minute lead gets a 4-minute grace.
- Needs harness agreement: its draft proposes 5 minutes for repeating.

## haurness-l confirmation of rounds 3 and 4 (2026-11-24)

Confirmed and written into their local reminder-tools SPEC: one common minimum (one-shot at least 2 min after acceptance; repeats
at least 10 min between occurrences); the harness validates `cron` as well as `every` (`invalid_schedule`: typed live error,
`blocked` on a change; Gate 1 pins a bounded validation method for timezone and calendar transitions); `initialize` advertises
both minimums, the per-channel active routine cap and the expiry defaults. Expiry grace starts at the scheduled instant: 2x the
acceptance-to-due lead for one-offs, 2x the occurrence interval for routines, capped at 1 day; `null` permits late delivery.
Left to contract review: the floor for short leads, a variable cron interval, the expiry outcome. Retries must preserve the
RESOLVED expiry (acp-client stores the resolved absolute expiry with the change and never recomputes it on resend). Idle stop:
per-Agent setting with conversation overrides; acp-client passes the largest applicable pending-reminder window; the harness
atomic stop check is authoritative.

## User decision, round 5 (2026-11-24): expiry grace bounds

Default `expiresAfter` grace = 2x the lead (one-shot) or 2x the interval (routine), clamped to a lower bound of 5 minutes and an
upper bound of 24 hours. A 2-minute lead therefore gets 5 minutes, not 4. Harness to confirm at contract review.

## Round 6 (2026-11-24): R7 grounding review and fence pin

- clad2a's grounding review (`reminders-r7-reviews` 02945d1) accepted: gate is plain `bun test` (2,070/214); wake includes
  `maybe_sent`; client-allocated `reminderId` with surviving high-water; memory repo `durable` bit; delete leak test for a
  reminders-only backend; offline cron stores a "harness default" expiry marker; a validation wake at acceptance + 2 min for any
  pending create or edit (a host launch/retry deadline, never a schedule rewrite); schedule edits keep the prior expiry policy;
  resume skips the lead check; a named `suspended` setter written in the channel suspend/resume transaction.
- haurness-l's fence (pinned in their SPEC): the deadline revision is monotonic across restarts of the same session; equal
  revision means equal `nextDueAt`; accept newer, ignore older, ignore and flag an equal-revision mismatch from the open or an
  event; no reset on open or reconnect; only a replacement session starts a new fence (so the fence is keyed by session
  identity). This replaces my provisional "open resets the fence".
- Cron expiry on the wire: omit `expiresAfter` for the default; send a duration or `null` only when supplied.
- Gate 1 issue (haurness-l): the harness must not revalidate a one-shot lead against its open time; the contract must pin a
  trustworthy original acceptance anchor for offline intents. acp-client stores `acceptedAt` immutably with each change and
  carries it in the payload via the adapter (field name pending).

## Round 7 (2026-11-24): harness status and staging

haurness-l: no frozen reminder contract and no runnable implementation SHA; the harness reminder work is not yet scheduled, so no
ETA. Staging they propose: the FIRST contract freezes the one-off, open and wake path (acceptedAt trust and stable expiry anchor;
(reminderId, changeId) receipt lookup before the stale high-water refusal, with the exact code; pause/resume update shape; expiry
state and event; bounded list cap, cursor TTL and invalidation; revisioned `nextDueAt`, capability and defaults; atomic idle-stop
response and ordering). Routines (variable cron interval and DST, the unattended-guard capability) are reviewed separately before
R9. They will send the approved contract SHA for R8 and later a one-off real-stdio implementation SHA. R7 stays independent.
Plan effect: R8 is split in two: R8a (steps 3-5 for one-offs, against the first contract) and R9 carries routines and the
full real-stdio acceptance.

## Round 8 (2026-11-24): R7 Part 2 review

cod2b-t replaced cod2a as implementer (cod2a-r did not start Part 2). Part 2 at `6a2a4ea` passed core-p's clean-copy gate (typecheck
clean; plain `bun test` 2,081/215, 0 fail, 35 snapshots; protected files not grown). clad2a's review (`reminders-r7-reviews`
2671ad9): all rulings implemented, NOT approved: 5 surviving mutants (maybe_sent in wake, paused exclusion, suspended setter in the
channel transaction, expiry drift on edit), a per-access ReminderService with a fresh memory repo, update/pause/resume accepted on a
terminal reminder, explicit `every.startAt` and 0 ms expiry unvalidated, plus coverage gaps (events, accessor, real 21->22 upgrade,
real SQLite delete). Follow-up assigned to cod2b-t. R8 carry-over: the validation wake (min(acceptedAt + 2 min, dueAt)) is a launch
deadline, so an unresolved entry leaves a past wake; R8 must rate-limit it with the restart budget (3 in 60 s), no spin.

## Round 9 (2026-11-24): contract released, decision 0031 (`34969fd9`, ref `aiagent/haurness-rh1-approved`)

Copied to `contracts/0031-one-off-reminders-34969fd.md`; it overrides the plan where they differ. Differences to carry:
- ONE-OFFS ONLY: create/update schedule is `{ at }`; `maxActiveRoutinesPerChannel` is 0 (routines disabled); `every`/`cron` stay
  out of R8 and need a separate harness gate before R9.
- Open returns `reminderChanges` outcomes, `nextDueAt`, `reminderRevision` AND the first bounded list page (`reminders`,
  `remindersNext`); lists via `reminder/list` (50 default, 100 max), cursors die on any reminder mutation (`invalid_cursor`).
- `expired` is its own state and its own event `reminder_expired` (not a `cancelled.by` value); `cancelled.by` is host | agent |
  channel_retired; new block reasons `stale`, `invalid_state`.
- `expiresAfter` on the wire is integral milliseconds (omit = default, null = none); the harness derives expiry from the stored
  anchor, so acp-client's local expiry is provisional and the displayed value comes from the harness row; a grace-only edit uses the
  stored lead anchor (R7's "re-resolve at the edit's acceptance" is superseded for the wire).
- `acceptedAt` is trusted if not more than 30 s ahead of the harness clock; lead is measured from it, including on schedule edits.
- Stop: `{ stopped:true }` or `{ stopped:false, reason: busy | next_due_soon }`; window defaults to 0.
- Harness timer is clamped to 60 s chunks with a wall-clock recheck; the cold wake is acp-client's (R-H3 on their side).
- Real-stdio tests wait for R-H2 (reviewed runnable SHA); R8 uses a scripted fake from 0031. Brief: `briefs/11-24-BRIEF-R8-reminders-wire.md`.

## Round 10 (2026-11-24): R8 rulings and haurness-l's clarifications

R8 conformance report (cod2b-t `e0caeaa`) reviewed by clad2a (`e204496`, 14 points); core-p rulings sent with the Part 2 go: no local
one-off cap; public event union without collisions (local kinds `reminder_intent_*`); schema 22 changed in place (R7 unreleased),
cache without a journal FK, staging-order column; never brick the open (local validation, quarantine, no verbatim batch resend);
no wake spin on a past deadline while the harness runs; unsupported/routine entries off the wake; receipt/row ordering; new
reminderId to correct a blocked create; session-replacement handling; routines_unavailable; explicit grace 300000..86400000;
idle stop without the explicit-stop flag. No edits under `src/native-harness/` (Cod1a owns it, Clad1a reviews).
haurness-l's answers: a schedule edit omitting expiresAfter recomputes a previously DEFAULTED grace from the new lead and keeps an
explicit duration or null; the receipt row is frozen as of that receipt (get/list authoritative); a blocked create is corrected by a
new reminderId; session identity is `OpenResult.sessionId` (a different id or a confirmed fresh create after confirmed absence is a
replacement; a lower revision is never evidence of replacement).

## Round 11 (2026-11-24): alpha 4dad65e; R8.5; routines contract 0032 (`973a522`) and haurness-l's pins

Alpha is `4dad65e` (R7, R8, joint acceptance, docs). R8.5 (typed harness client, refactor only): `reminders-typed` `b2b4fbe`, core-p gate
2,164/225, clad2a review in progress. R9 (routines): brief `briefs/11-24-BRIEF-R9-routines.md`, contract copy `contracts/0032-...md`,
Part 1 conformance report (cod2a-r `e7f1f6e`). haurness-l's answers:
1. Keep 0031 ordering and per-entry commit. A create/edit proof-budget error has no receipt or partial mutation for that entry; earlier
   committed channel edits, guard enable and receipts survive; later entries are skipped and no due processing runs on that failed
   startup. The client keeps the frozen batch unacknowledged and retries it exactly (bounded) with original ids, anchors and payloads;
   if create already published the session, recover through an executable open of the same confirmed identity (no replacement, no
   stripping). Do not rely on error.data identifying the entry.
2. First-open split confirmed: non-activating edits (owed pause/cancel, text, grace...) go in startup; create/resume/schedule
   replacement are held until initialize confirms `routines` + `unattendedTurnGuard` and the executable open confirms the effective
   guard, then sent live with their original anchors. Held activations alone must not arm a wake/relaunch loop. Per-reminder intent order
   is preserved (never send a later change ahead of a held earlier one on the same id; resolve the local conflict instead). The host
   may request a one-time guard enable on open after negotiation.
3-4. Exact migration disposition event/row spelling and live ordering are NOT pinned yet: Cod1a publishes a small wire pin for Clad
   before we depend on it. Recommended: routine_disposition live/post-commit, no replay/list API or tuple id, disposition before the
   associated reminder_fired in the same commit, migration hold visible in the authoritative row.
5. `until` before the first eligible occurrence is `invalid_schedule` (inclusive); interval rows carry an explicit resolved `startAt`;
   a replacement advances strictly beyond the persisted processed-through fence, and is rejected if no eligible first occurrence remains.
6. Require `capabilities.unattendedTurnGuard` and `capabilities.routines` before sending routine config and fail explicitly on
   incompatibility; `invalid_config` for an incompatible saved guard value (no structured data required); the open result confirms the
   effective `maxConsecutiveTurns`.
R9 can continue on the settled parts; joint real-stdio acceptance waits for the approved runtime SHA.
