# Plan: reminders, acp-client half

Status: planning only, 2026-11-24 (core-p), revision 3 (haurness-l's planning answers a to e folded in; they are planning decisions, not a frozen wire contract). No code, no briefs sent, no runtime briefs until haurness-l
releases the wire decisions below. Grounded in `../11-23-SPEC-reminders-and-routines.md` (reviews 1 and 2), the code on
`integration-r456-status` (`src/native/host.ts`, `records.ts`, `src/persistence/channels.ts`, SQLite schema 21) and,
since revision 2, the harness's `0004-DESIGN-reminder-tools/SPEC.md` (a local untracked draft in the haurness-l
worktree; no branch contains it yet; "Proposed for v1"). Where the draft and revision 1 disagreed, the draft wins; the
changes are listed in "What changed from revision 1". Cod1a and Clad1a stay on the native harness tool gates; this plan
does not use them. Implementer and reviewer for this track are cod2a and clad2a, when the user schedules it.

## What the harness draft settles (design level) and what it leaves open

Settled enough to design against:
- **One open fence.** On an executable `session/create|open` (not the legacy load): recover committed state, apply pending
  channel changes in their startup order, apply reminder intents in their SUBMITTED order against the resulting channel
  state, process eligible due reminders on that state, return the intent outcomes and the next eligible due time (null
  when none), then release eligible work to the scheduler. An offline cancel or pause therefore wins over an overdue
  occurrence not yet queued; a committed notice is already the inbox's. Inspection-only opens do no reminder writes or
  firing.
- **Intent identity.** Each mutation intent has an id distinct from its target reminder id; a retry with the same intent
  ids returns their recorded outcomes without reapplying or queuing duplicate notices; reusing an intent id with changed
  arguments is a conflict; a state-dependent rejection is `blocked` with a reason, and acp-client keeps it visible until
  corrected or removed.
- **Absolute UTC only.** acp-client resolves relative schedules (`in`) once, before staging; the harness never sees `in`;
  replay keeps the original due time.
- **`nextDueAt`** is revisioned, returned on executable open and published when the earliest eligible deadline changes;
  null when none; the host uses the revision to avoid replacing a newer value with an older one. The open response is
  authoritative for a missed update. Fire carries reminder id, scheduled occurrence time and notice id; cancel carries the
  reminder id. Design around authoritative state reconciliation at open: do NOT assume historical event replay.
- **Wake.** acp-client persists one next reported deadline per Agent beside the pending intents; effective deadline =
  min(that value, the eligible deadline of any pending create or edit). At the deadline it lazy-starts; a running harness
  has its own timer; a stopped one processes due work on open; no wake RPC, no periodic starts. The consumer lists cached
  records plus pending intents without opening a stopped harness (the cache is last-confirmed state). Accepted v1 window:
  if the harness commits before acp-client persists the new wake time, a crash leaves a stale deadline, recovered at the
  next eligible open, possibly late; a wake may also pay a cold start.
- **Host operations.** create, get, list (one channel or the whole session; opaque cursor, stable order), update, pause,
  resume, cancel; a host write NAMES the destination channel and SUPPLIES any additional policy names, which the harness
  validates at creation; the consumer capability applies to native conversations only; the tool catalog and permission gate
  apply to the agent tools, not to host writes.
- **Notices.** The notice id derives from reminder id and scheduled instant; a fired event means "the notice was queued";
  the eventual turn follows the normal channel events.

Planning answers from haurness-l (2026-11-24; planning decisions, not a frozen wire contract):
- **Whole-session list (reconcile):** a bounded list with opaque session- and scope-bound cursors, deterministic stable
  ordering (proposed: reminder id), and a revision fence that detects an invalidated sweep so the host can restart it. The
  wake value comes ONLY from the executable open and revisioned deadline updates: do not depend on list pages sharing the
  open fence; if the contract adds a deadline read next to the list, it carries its own revision. Exact cursor and page
  limits and the recovery under churn are contract work.
- **Host writes** are attributed to the host. acp-client forwards ONLY optional additional `policyNames` supplied by an
  authorized consumer; the harness resolves the destination channel's policy at firing, so the channel policy is NOT
  copied into the additional names.
- **`{ every }` without `startAt`:** acp-client sends an absolute `startAt`, resolved ONCE at acceptance, on both the live
  and the stopped path, so retries are stable; the harness-local defaults are a contract detail.
- **Correction of a blocked intent** is a NEW intent id; once the host has durably recorded the blocked outcome it stops
  resending that intent and keeps it visible locally until corrected or discarded; the id is never reused; the harness's
  retention of recorded outcomes (dedup) is pinned separately.
- **Inspect-only:** `session/open` has no explicit inspect-only flag, and omitting intents is NOT a safe read-only signal.
  For a stopped session acp-client serves cached reminders plus pending intents WITHOUT launching it; every acp-client
  open is an executable open. If a remote inspect-only path is ever needed it is negotiated explicitly and requires no
  writes, no firing and no scheduler release.
- Event replay stays unassumed; idle-stop and capability negotiation stay gated; the routine defaults stay pending review.

Still open (wire dependencies; haurness-l is deciding): exact fields, echoes, versions, codes and limits; the capability
name and runtime negotiation; an explicit event-replay guarantee (revision 2 assumes none); a race-free idle-stop fence
(the existing `session/idle` is only a read); routine defaults (catch-up, overlap, minimum interval, limits), still
proposed in the harness draft; daylight-saving gaps and folds; the unattended-turn guard (a prerequisite for enabling
unattended routines).

## What changed from revision 1

1. Intents are keyed by their OWN id (distinct from the reminder id); they are ordered; once an intent may have been sent it
   is FROZEN (a change after that is a new intent with a new id: reusing an id with changed arguments is a conflict).
2. Coalescing is allowed only among never-sent intents; the "cancel supersedes create" shortcut applies only if the create
   was never sent.
3. Blocked intents are first-class: kept and listed until corrected (a new intent) or removed (a local discard control).
4. The reported deadline carries a REVISION; a response or event older than the stored revision never replaces it.
5. An explicit authoritative reconcile after open (the whole-session host list, paged) refreshes the cache and the wake;
   no reliance on missed events being replayed.
6. Pending intents contribute to the wake only when eligible (not for a suspended or retiring channel, not paused).
7. Open sequence wording fixed to `session/create|open` (the earlier "load view" is the legacy path).
8. Acceptance now names the draft's joint scenarios (lost open response, missed deadline event, the accepted crash window).
9. Host writes: attributed to the host; only the consumer's optional additional policy names are forwarded (never the channel
   policy); `startAt` for an `every` intent is resolved once at acceptance.
10. Reconcile is a bounded, restartable sweep (opaque cursor, ordered by reminder id, a revision fence), never the source of
    the wake value; no acp-client open is inspect-only, so a stopped session is read from the cache and pending intents.

## What exists to build on

- Open sequence: `host.ts #open` runs `initialize`, then `startupBatch()` (pending channel changes from the durable
  `channels?` repository), then `openOrCreate(..., batch)`, then `acknowledgeOpen`. Reminder intents ride the same open,
  after the channel changes, in submitted order.
- `ChannelPersistence` is the pattern for the intents (coalesced desire, version as wire id, clear only the confirmed
  version, one transaction with the conversation write), with the reminder-specific change that intent ids are distinct
  from targets and become immutable once possibly sent.
- Lazy start: `ensureStarted()` is single-flight; `agent.harness.start()` exists. A wake calls it.
- Not built: any host-owned timer, `idleStopMs` for the native host (the only `idleStopMs` today is the orchestrator
  pool's), `conversationCapabilities.reminders`, the reminder wire, an inspect-only/executable open distinction in the
  host (check in step 0).

## Pieces and order

Every step ends with the full suite (RAM-backed `TMPDIR`), new tests about 20x in isolation, a clean-copy gate and clad2a
review. Steps 0-2 can proceed before the wire decisions land only if their wire-facing part is isolated behind one adapter
file; haurness-l asked for no runtime briefs yet, so nothing starts.

**Step 0: grounding and decisions.** A report only: host start/stop paths; where the timer and wake index belong (host
vs `src/native/reminders/`); the storage shape (below); whether the host's open already distinguishes executable from
inspect-only opens; the policy-names and creator decisions for host-created reminders; how the reconcile list pages
within the open budget. Storage recommendation to check: a sibling `reminders?` repository with `capabilities.reminders`
(schema 22), three parts: (a) `reminder_intents`: intent id, target reminder id, kind (create, update, pause, resume,
cancel), payload, global submitted-order sequence, state `pending | maybe_sent | applied | blocked(reason)`, never mutated
after `maybe_sent`; (b) `reminder_cache`: last-confirmed reminders per conversation (id, schedule, text, state, next
run, revision); (c) `wake_index`: one row per Agent: reported `nextDueAt` plus its revision, and the derived effective
deadline. Gate: report reviewed; the wire questions answered.

**Step 1: durable store and wake index (no timers, no wire).** The repository above, transaction-scoped like `channels?`:
append an intent (assign id and sequence), mark `maybe_sent` before a send, record an outcome (`applied`, `blocked` with
reason, or conflict) durably: `applied` clears the intent; a recorded `blocked` outcome stops the resend but the intent stays
visible, with its reason, until corrected (a NEW intent id, never a reused one) or discarded, coalesce only never-sent intents (a cancel supersedes a
never-sent create or update and nets to nothing; an update merges onto a never-sent create), a local `discard` of a
blocked intent, the cache rows, and the effective deadline recomputed as min(stored `nextDueAt`, eligible pending create or
edit deadlines): pending cancels, pauses, intents for a suspended or retiring channel contribute nothing. A response or
event with an older revision never replaces the stored one. A conversation delete removes its intents and cache rows in
the same transaction. SQLite schema 22 with an upgrade test from 21; the memory implementation for backends without it
(no durable intents, no wake across restart; documented). Gate: repository tests (the coalescing table, freeze after
`maybe_sent`, clear-only-confirmed, older-revision rejection, wake recompute, transactional delete), the upgrade test.

**Step 2: local validation and the library model.** `Reminder` type; `conversation.reminders` (create, get, list, update,
pause, resume, cancel, `discardBlocked`); `agent.reminders.list()` (whole Agent, paged); `conversationCapabilities.reminders`
(true native, false ACP). Local validation before any write: schedule syntax (`at`, `every`, `cron` with timezone; `in`
converted to an absolute `at` at acceptance, also for a running harness; for `every` without `startAt`, resolve `startAt`
locally to an absolute instant so a replay is stable), the 15-minute consumer minimum for repeating schedules, a known
policy name when config is known, typed errors for limits and for a missing capability. Host writes name the channel (the
conversation's) and are attributed to the host; only optional additional `policyNames` passed by an authorized consumer are
forwarded (the harness resolves the channel's own policy at firing, so it is never copied into them). Harness-running path: a request, done on confirmation; harness-stopped path: intent plus wake index
in one transaction, `state: "pending"`. Events (created, fired, changed, confirmed, blocked, cancelled) on the existing
conversation event path, deduplicating fires by notice id. A client-supplied reminder id is validated. Lists with the
harness stopped: cached plus pending intents marked pending; blocked intents stay listed. Gate: unit tests against a fake
harness client; a crash-retry test (the same intent id twice yields one reminder; a changed payload under the same id is a
conflict, not a silent overwrite).

**Step 3: startup ordering, confirmation and reconcile.** In `#open`, after `startupBatch` and in the same open request:
send reminder intents in submitted order, marking each `maybe_sent` first. Ordering rule to hold and test: channel changes
applied, then reminder intents, then eligible due reminders, then the open fence completes. A reminder created for a
conversation retired in the same batch comes back `blocked` (reason from the harness); one for a channel suspended in the same
batch is held, not fired; an offline cancel or pause beats an overdue occurrence. Each outcome is recorded by intent id:
`applied` clears it; `blocked` keeps it visible; a conflict is surfaced as a defect; the reported `nextDueAt` replaces the
wake index only with a newer revision. After the open completes, reconcile authoritatively with a bounded, restartable SWEEP: page the whole-session host list
(bounded pages, opaque session- and scope-bound cursor, stable order by reminder id) into the cache, under the list's
revision fence; if the fence reports the sweep invalidated (churn), restart it, bounded by a restart budget (then keep the
cache as last-confirmed state, flagged unreconciled, and retry on the next trigger; it never blocks the open or a wake).
The sweep never feeds the wake value: that comes only from the open and the revisioned deadline updates (a separate
deadline read, if the contract adds one, has its own revision); no dependence on missed events. A crash between the harness
applying and acp-client clearing: the resend by intent id returns the recorded outcome (test with a real stdio restart;
this is the draft's "replay after a lost open response"). Every acp-client open is executable: acp-client never opens a stopped session merely to read it (the cache plus pending
intents answer `list` and `get`), because omitting intents is not a safe read-only signal. Gate: ordering tests with a
scripted fake harness for each interleaving; sweep tests (an invalidated sweep restarts within its budget; pages, ordering
and cursor reuse across scopes are rejected); real-stdio restart tests when the harness side exists.

**Step 4: wake timer and the late-wake window.** A host-owned timer armed from the wake index; at expiry `ensureStarted()`
(single-flight with any other start; the cancellable start and `harness_unresponsive` unchanged); opening is enough, no
wake request. A running harness: the wake does nothing. The timer rearms on every index change, is cleared on
`Agent.close()`, and is rebuilt at Agent construction from the stored index (an overdue index starts the harness once at
once). Accepted window, documented: a cold start means the turn begins after the due time by the start time plus the open;
the crash window of the draft (the harness commits before acp-client persists the wake) recovers at the next eligible open,
possibly late; a missed deadline event is repaired by the open response and the reconcile. Proposed numbers (not in the
draft): a wake fire up to the start deadline (30 s) late is not a failure. Backoff: a failed wake start retries on the
existing restart budget (3 in 60 s), then the index stays and the host surfaces `HarnessUnavailableError`; it must not
spin. Injectable clock. Gate: fake-clock tests (fire, rearm, race with a manual `start()`, race with `close()`, overdue
at construction, failed start does not loop, an older-revision event after a newer one).

**Step 5: idle stop (blocked on the harness idle fence).** `harness.idleStopMs` (off by default). Stop only when
acp-client has no turn running or held, no pending permission, no held channel or reminder intent, and the harness reports
idle (turn, inbox, approval; future reminders are not work) through a race-free fence: the existing `session/idle` is only
a read, so this step stays blocked until the harness defines an atomic idle-and-stop fence. Not when the reported
`nextDueAt` is inside the window (about twice the measured startup time; floor and ceiling configurable). After a stop,
arm the wake for the next due time; activity starts it again, racing the stop safely (started once). Gate: fake-harness tests
for each non-idle reason, the window boundary, stop then wake, stop racing a send.

**Step 6: routines on the library side** (the draft's step 3, after the routine decisions): routine options on the model,
the 15-minute minimum, update, pause and resume intents with the freeze rule, the catch-up counters (missed, skipped) from
the harness; no schedule computation in acp-client beyond the local minimum check and the wake value. Enabling consumer
routines is gated on the harness's unattended-turn guard (a capability to negotiate).

**Step 7: real-stdio joint acceptance** (with the harness implementation; a live provider only with the user's approval,
otherwise the deterministic fixture model), including the draft's joint scenarios:
1. Stop a harness holding a saved reminder: no process runs; the wake starts it once; one notice to the original channel;
   `reminder_fired` once; the list shows it done.
2. Cancel an overdue reminder while stopped: zero notices on open.
3. Offline create, cancel and update of different reminders in one open, each confirmed by intent id; none duplicated after a
   kill between apply and clear (the lost open response).
4. A missed deadline event: acp-client misses a nextDueAt update; the open response and the reconcile repair the wake.
5. The accepted crash window: the harness commits and advances, acp-client dies before persisting the wake; the next eligible
   open recovers it, late; assert the documented behaviour.
6. Delete a conversation with an offline pending reminder: nothing fires, the cache is clean.
7. Overdue at open after downtime: fires once (coalesced for a routine), late but not lost.
8. A suspended channel: held, excluded from the wake, no wake loop and no idle-stop restart loop; resume runs it.
9. Idle stop with a reminder far away: the harness stops and wakes at the due time; with one inside the window it stays up.
10. A wake racing the harness's own timer: one firing.
11. An agent-created reminder (a tool call in a turn): appears via the created event, in the cache after the next open, and wakes
    after an idle stop.
Gate: the real-stdio file passing 20x, plus the suite.

**Step 8: documentation** (library guide, the spec's open item resolved, limitations kept: wakes only while acp-client runs; the
narrow crash window; the cold-start delay; the cache is last-confirmed state).

Suggested slicing for briefs (nothing starts until haurness-l releases the wire decisions and the user schedules it): R7 =
steps 0-2 (store, model, validation: harness-free), R8 = steps 3-5 (wire, timer, idle), R9 = steps 6-8.

## Open contract questions

Settled at design level by the harness draft (details open): intents inside the open next to `channelChanges` on
`session/create|open`, applied in submitted order after channel changes; a distinct intent id, replay of the recorded
outcome, a conflict for changed arguments, `blocked` with a reason for a state rejection; revisioned `nextDueAt`, null if
none, on the open and as an event; fire fields (reminder id, scheduled occurrence time, notice id) and the cancel field
(reminder id); no assumption of event replay; absolute UTC only (no `in` from acp-client).

Still wire dependencies for haurness-l:
1. **Exact fields:** the `reminderIntents` shape (an intent id, a target reminder id, a kind, a payload), the echo and
   revision fields on outcomes, the result codes and blocked reasons (`channel_retired`, `invalid_policy`,
   `invalid_schedule`, limit exceeded, conflict), and the limits (minimum interval, active count).
2. **Capability and negotiation:** the advertised name (and runtime negotiation) for reminder intents, and for the unattended
   guard; acp-client refuses `reminders: true` and refuses to send intents without it (a typed error, never a silent pending).
3. **Event replay:** an explicit statement whether an open (or a subscription) replays fires or cancels missed while
   acp-client was down; revision 2 assumes none and reconciles from state.
4. **Idle fence:** an atomic idle-and-stop (or a fence token) because `session/idle` is only a read; with it, `nextDueAt`.
5. **Routine decisions:** catch-up (coalesce), overlap (skip), minimum interval (5 min harness, 15 min consumer, local),
   limits, daylight-saving gaps and folds, and how a prior occurrence stays identifiable through take, completion and restart.

Answered (planning level) by haurness-l, 2026-11-24: the reconcile list (bounded, opaque scope-bound cursor, stable order by
reminder id, a revision fence; the wake never depends on it); host writes (attributed to the host; only consumer-supplied
additional policy names are forwarded); the absolute `startAt` for an `every` intent (resolved once at acceptance, live and
stopped); the correction of a blocked intent (a new intent id; a durably recorded blocked outcome stops the resend); inspect-only
(no flag; a stopped session is read from the cache and pending intents; no acp-client open is inspect-only).

New questions, for haurness-l (contract work, not blocking the plan):
6. **Sweep contract:** the page limit, the cursor lifetime, the fence signal for an invalidated sweep, and the churn recovery
   rule (how many restarts before the host should stop and flag the cache); is the deadline read, if added, separate?
7. **Retention of recorded intent outcomes:** how long the harness keeps them. A resend of an older intent after the retention
   window is unsafe: acp-client must know the window (or a signal) so it can retire stale pending intents instead of replaying
   them as new.
8. **Additional policy names:** what the harness does with an unknown or unauthorized name at creation (a `blocked` reason?),
   and what "authorized consumer" means on the wire (acp-client treats its own library consumer as authorized).
9. **Remote inspect-only:** only if the user ever needs it; it would be negotiated explicitly and require no writes, firing or
   scheduler release.

For the user and spec owners (unchanged where not answered):
11. **Defaults:** coalesce for missed runs, skip for overlap, 5 and 15 minutes, 20 per channel.
12. **Wake ownership:** one row per Agent in acp-client's database; with several Agents sharing a database, only the SQLite
    owner arms the timer (proposed).
13. **Backends without the repository:** `create` with the harness stopped fails with a typed error rather than recording an
    intent a restart loses (proposed).
14. **ACP conversations:** the capability is false and `create` throws a typed error; no interim emulation.
15. **Idle-stop window:** measured startup time with a floor; per Agent or global.
16. **Late-wake tolerance:** the 30 s figure is a proposal.
17. **`stop()` and the wake:** an explicit `stop()` keeps the wake armed (proposed); confirm or give a disarm control.
18. **Confidentiality:** reminder text and policy names are stored in the clear in acp-client's database (intents and cache).
