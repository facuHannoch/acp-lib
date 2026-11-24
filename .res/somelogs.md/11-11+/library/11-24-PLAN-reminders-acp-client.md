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

## Open points to pin with the harness (Gate 1; none blocks R7)

1. **Method names:** the contract text says `reminderChanges` go on the session "create and load"; the earlier planning answer said
   the executable open `session/create|open` (not the legacy load). Which exact methods carry them?
2. **`changeId` semantics:** it mirrors decision 0020 (a per-reminder version, echoed). Pin: a replay with the same `changeId` and
   the same payload returns the recorded outcome; the same `changeId` with a different payload is a `conflict`; a lower `changeId`
   than the recorded one is applied as a no-op or reported stale?
3. **Pause and resume:** the ops are `create | update | cancel`, while `reminder_changed` mentions pause and resume: are they
   `update` payloads?
4. **Blocked reasons and events:** `not_found` (an update of something unknown) is missing from the reasons list; `expired`
   (from `expiresAfter`) is missing from `reminder_cancelled.by` (or does an expired one fire late?). Pin the outcome and the
   report for an expired reminder, and the `expiresAfter` default values.
5. **Revision on the open:** does the open's response carry the `revision` for `nextDueAt` (the event does)?
6. **The open's reminder view:** is it complete or bounded/paged (limits are 20 per channel, but many channels)?
7. **Capability for the unattended guard:** separate flag, needed to enable consumer routines.
8. **Repository naming:** the answers mention a `channels?` repository for the refusal check; the plan uses a new `reminders?`
   repository (schema 22): refuse when the harness is stopped and `reminders?` is absent.
9. **Sweep and retention** (earlier grounding): the page cap, the cursor lifetime, the invalidation code, and the session-lifetime
   retention of recorded outcomes remain Gate 1.

Questions resolved for the user and spec owners: defaults confirmed; text in the clear; only the SQLite owner arms the timer;
stop keeps the wake and close clears the timer; `reminders_unavailable`; `expiresAfter` on both APIs. Still pending: the idle
window floor and whether it is per Agent or global; whether the 15-minute consumer minimum should also apply to agent-created
routines (the agent tool goes through the harness); and the `expiresAfter` defaults.
