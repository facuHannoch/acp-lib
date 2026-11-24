# Plan: reminders, acp-client half

Status: planning only, 2026-11-24 (core-p). No code, no briefs sent. Grounded in
`../11-23-SPEC-reminders-and-routines.md` (reviews 1 and 2) and the code on `integration-r456-status`
(`src/native/host.ts`, `records.ts`, `src/persistence/channels.ts`, SQLite schema 21). The harness
`0004-DESIGN-reminder-tools` is not in this worktree yet; every harness-side shape below is an assumption until it
arrives (see Open contract questions). Cod1a and Clad1a stay on the native harness tool gates; this plan does not
use them. Implementer and reviewer for this track are cod2a and clad2a, when the user schedules it.

## What exists to build on

- Open sequence: `host.ts #open` runs `initialize`, then `startupBatch()` (pending channel changes, read from the
  durable `channels?` repository), then `openOrCreate(..., batch)`, then `acknowledgeOpen`. Pending changes already
  go inside the open and apply before work. Reminder intents ride the same open.
- `ChannelPersistence` is the pattern for the intents: coalesced desire, version as wire id, clear only the
  confirmed version, one transaction with the conversation write.
- Lazy start: `ensureStarted()` is single-flight; `agent.harness.start()` exists. A wake calls it.
- Not built: `idleStopMs` for the native host (the only `idleStopMs` today is the orchestrator pool's), any timer
  owned by the host, `conversationCapabilities.reminders`.
- Harness wire: `capabilities.startupChannelChanges` is checked at open. A reminder feature needs the same kind of
  advertised capability, and acp-client must refuse to claim `reminders: true` without it.

## Pieces and order

Every step ends with the full suite (RAM-backed TMPDIR), new tests ~20x in isolation, a clean-copy gate, and
clad2a review. Steps 0-1 can proceed before the harness spec lands if their wire-facing part is isolated behind one
adapter file.

**Step 0: grounding and decisions.** A report only: current host start/stop paths, where a timer and the wake
index belong (host vs a new `src/native/reminders/` module), whether intents live in the `channels?` repository or
a sibling `reminders?` repository, and the async-vs-sync records question again for the new half. Recommendation to
check: a sibling `reminders?` repository with `capabilities.reminders`, schema 22, because reminder intents are
keyed by reminder id, not channel, and several can be pending per channel. Gate: report reviewed, and the wire
contract questions below answered.

**Step 1: durable store and wake index (no timers, no wire).**
- `reminders?` repository, transaction-scoped like `channels?`: pending intents (create / update / cancel) keyed by
  reminder id, with a per-id version; a coalescing rule (a cancel supersedes a pending create or update; an update
  merges onto a pending create; a create then a cancel before any open nets to nothing but is still sent as
  create+cancel only if the harness may have seen the id, which it hasn't, so it is dropped locally); the read
  cache of confirmed reminders per conversation; the one-row-per-Agent wake index (`nextWakeAt`, plus the harness's
  last reported next due time kept separately so the intents' due times can be recomputed).
- Wake value = min(harness last reported due, due times of pending create and schedule-edit intents). Pending
  cancels and pauses never move it.
- SQLite schema 22 with an upgrade test from 21; memory implementation for backends without it (documented
  limitation: no durable intents, no wake across restart, like channels).
- Delete of a conversation: its reminders' intents and cache rows go in the same transaction (the channel retire
  already cancels them harness-side; the local cache must not show them).
Gate: repository tests (coalescing table, clear-only-confirmed-version, wake-index recompute), upgrade test,
transactional delete test.

**Step 2: local validation and the library model.** `Reminder` type, `conversation.reminders` (create, get, list,
update, pause, resume, cancel), `agent.reminders.list()`, `conversationCapabilities.reminders` (true native, false
ACP). Local validation before any write: schedule syntax (`at`, `every`, `cron` plus timezone; `in` converted to
`at` at creation), the 15-minute consumer minimum for repeating schedules (cron: between consecutive runs), a
known policy name when config is known, typed errors for limits. Harness-running path: a request, done on
confirmation. Harness-stopped path: write intent plus wake index in one transaction, return `state: "pending"`.
Events: created, fired, changed, confirmed, blocked, emitted through the existing conversation event path.
Lists with the harness stopped: cached confirmed plus pending intents marked pending; blocked intents stay listed.
Id is chosen up front by acp-client (a client-supplied `id?` is validated, duplicates are a typed error).
Gate: unit tests against a fake harness client; crash-retry test (same id sent twice, one reminder).

**Step 3: startup ordering and confirmation.** In `#open`, after `startupBatch` and inside the same open request:
send reminder intents. Ordering rule to hold and test: **channel changes are applied, then reminder intents, then
past-due reminders become eligible, then the load view is read.** A reminder created for a conversation whose
retirement is in the same batch must come back `blocked: channel_retired`; a reminder intent for a channel
suspended in the same batch must be held, not fired. Each intent is cleared only on a confirmation by id and
version; `applied` or `blocked` with reason maps to `reminder_confirmed` / `reminder_blocked`; the harness's
reported next due time replaces the wake index. A crash between harness apply and acp-client clear: resend is
idempotent by id (test with a real stdio restart).
Gate: ordering tests with a scripted fake harness for each interleaving above; real-stdio restart tests when the
harness side exists.

**Step 4: wake timer and late-wake window.** A host-owned timer armed from the wake index; on fire, `ensureStarted()`
(single-flight with any other start; the existing cancellable start and `harness_unresponsive` behaviour unchanged);
opening is enough, no separate wake request. If the harness is already running, the wake does nothing. Timer rearms
on every index change, is cleared on `Agent.close()`, and is re-created at Agent construction from the stored index
(a restart with an overdue index starts the harness at once, once). Accepted late-wake window: cold start means a
turn begins after the due time by start time plus open. Numbers to propose: do not treat a wake as failed if the
fire is up to the start deadline (30 s) late; an acp-client that was closed through a due time wakes at the next
open and the harness reports the late firing (`missed`/late metadata as the harness defines). Backoff: a wake whose
start fails retries on the existing restart budget (3 in 60 s), then the index stays set and the host surfaces
`HarnessUnavailableError`; it must not spin. Timer uses an injectable clock for tests.
Gate: fake-clock tests (fire, rearm, race with a manual `start()`, race with `close()`, overdue at construction,
failed start does not loop).

**Step 5: idle stop (depends on harness idle query).** `harness.idleStopMs` (off by default). Stop only when
acp-client has no turn running or held, no pending permission, no held channel intent, and the harness reports idle
(turn, inbox, approval; future reminders are not work). Not when the reported next due time is inside the window
(about twice the measured startup time; acp-client measures start durations itself, with a floor and a ceiling, and
exposes the window as config). After stop, arm the wake for the next due time; activity starts it again, racing the
stop safely (started once). Without a harness idle query this step is blocked (question 5).
Gate: fake-harness tests for each non-idle reason, window boundary, stop-then-wake, stop racing a send.

**Step 6: routines on the library side** (spec step 3, scheduled after the above): routine options on the model,
the 15-minute minimum, `update`/`pause`/`resume` intents with the version rule, missed and skipped counters
surfaced from the harness. No schedule computation in acp-client except the local minimum-interval check and the
wake value; the harness computes occurrences.

**Step 7: real-stdio joint acceptance** (with the harness's reminder implementation; live provider only on the
user's approval, otherwise the deterministic fixture model):
1. Create a consumer reminder with the harness stopped; no process starts; restart acp-client; the wake fires at
   the due time; one turn runs; `reminder_fired` once; `list` shows it done.
2. Offline create + cancel + update of different reminders in one open; each confirmed by id; none duplicated after
   a kill between apply and clear.
3. Delete a conversation with an offline pending reminder: nothing fires, cache clean.
4. Overdue at open after downtime: fires once (coalesced for a routine), late but not lost.
5. Suspended channel: reminder held, wake index excludes it, no wake loop, no idle-stop restart loop; resume runs it.
6. Idle stop with a reminder far away: harness stops, wakes at due time; with one inside the window: stays up.
7. Wake racing the harness's own timer: one firing.
8. Agent-created reminder (tool call in a turn): appears via `reminder_created`, in the read cache after the next
   open, and wakes after an idle stop.
Gate: the real-stdio test file passing 20x, plus the suite.

**Step 8: documentation** (library guide, the spec's Open item resolved, limitations kept: only wakes while
acp-client runs; the narrow crash window; cold-start delay).

Suggested slicing for briefs: R7 = steps 0-2 (store, model, validation; harness-free), R8 = steps 3-5 (wire,
timer, idle), R9 = steps 6-8. Nothing starts until the user schedules it.

## Open contract questions

For haurness-l (harness side), blocking the wire-facing steps:
1. **Where intents travel.** Inside `session/create`/`session/load` next to `channelChanges` (a new
   `reminderIntents` field plus `capabilities.startupReminderIntents`), or a separate request after open? Ordering
   needs them applied after channel changes and before past-due reminders become eligible, which favours the open.
2. **Intent identity and result shape.** Per-intent version/echo id like `changeId`, results `applied | blocked` with
   reasons; the blocked reasons list (`channel_retired`, `invalid_policy`, `invalid_schedule`, limit exceeded, id
   conflict with a different payload?). Is a repeated identical create `applied` and a different payload with the
   same id a conflict?
3. **Next due time.** Field name and shape in the open response and in events; is it null with none; does it
   already exclude suspended-blocked reminders (spec says yes); is it a full recompute after each change or a delta?
4. **Fire and cancel reports.** Event names and fields (id, occurrence time, `missed`/late count, skipped); delivery
   guarantee across a reconnect (does the open's view replay fires acp-client missed while it was down?).
5. **Idle query.** Is there a `session/idle` (or status field) that answers "no turn, empty inboxes, no approval"
   atomically with a stop fence, and does the reported next due time come with it? Needed for step 5.
6. **Limits ownership.** Harness min interval 5 min / 20 per channel; confirm acp-client's 15-minute stricter check
   is only local and the harness's typed refusal surfaces as `blocked` for an intent.
7. **Capability flag.** Name for the harness advertisement; acp-client refuses `reminders: true` and refuses to
   send intents without it (typed error at `create`, not a silent pending).
8. **`in` conversion.** Spec says acp-client converts for stopped-harness creates; confirm the harness never sees
   `in` from acp-client.

For the user / spec owners:
9. **Defaults still open in the spec:** coalesce for missed runs, skip for overlap, 5/15 minutes, 20 per channel.
10. **Wake index storage.** One row per `Agent` in acp-client's database; with several `Agent`s sharing a database,
    is the wake owned by the persistence owner (the existing SQLite owner lock) only? Proposed: yes, only the owner
    arms the timer.
11. **Backends without the repository.** Memory-only intents mean no durable offline reminder; proposed: `create`
    with the harness stopped fails with a typed error rather than recording an intent that a restart loses. The spec
    does not say.
12. **Consumer reminder on an ACP conversation.** Capability false, so `create` throws a typed error; confirm no
    interim emulation.
13. **Idle-stop window source.** Measured startup time with a configured floor; confirm the floor and whether the
    window is per Agent or global.
14. **Late-wake acceptance numbers** (30 s tolerance above is a proposal, not in the spec).
15. **Timer ownership across `harness.restart()` and `harness.stop()`:** an explicit `stop()` keeps the wake armed
    (proposed) so a stopped-by-consumer harness still wakes; confirm, or give a way to disarm.
16. **Reminder text confidentiality:** reminder text and policy names are stored in acp-client's database in the
    clear as intents and cache; confirm that is acceptable under the confidentiality todo.
