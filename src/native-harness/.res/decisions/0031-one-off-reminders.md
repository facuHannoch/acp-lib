# 0031 — One-off reminder wire and commit rules

## Problem and choice

A running harness needs one timer to queue durable work. A stopped harness
needs an authoritative deadline for its optional host supervisor. Reuse the
external-notice inbox and startup fence. Polling or a separate wake RPC would
start empty containers and could race offline cancellation. Routines and their
unattended guard have a separate gate.

## Requests and records

Initialize advertises `capabilities.reminders: true` and `reminderLimits` in
the description: `{ minLeadMs:120000, minIntervalMs:600000,
maxActiveRoutinesPerChannel:0, minExpiryGraceMs:300000,
maxExpiryGraceMs:86400000, expiryMultiplier:2 }`. Zero disables routines.

Executable `session/create` and `session/open` accept `reminderChanges`.
Each entry is `{ reminderId, changeId, op, payload }`, with a positive safe
integer changeId. Strict payloads:

- create: `{ channel, schedule:{ at }, text, acceptedAt, policyNames?,
  expiresAfter? }`.
- update: a nonempty patch of `text`, `state:"active"|"paused"`,
  `schedule:{at}`, and `expiresAfter`; `acceptedAt` is required exactly when
  schedule is supplied. Destination and original policies are immutable.
  A grace-only edit uses the stored lead anchor.
- cancel: `{}`.

Host live writes use the same entries with `reminder/change`. Host reads use
`reminder/get { id }` and `reminder/list { channel?, after?, limit? }`.
Get returns `{ reminder }` or not_found; list returns `{ reminders, next? }`.
The open response includes `reminderChanges` outcomes and the same bounded
first list page under `reminders` and optional `remindersNext`. Inspect-only
open can list saved rows but supplies no wake authority. Lists order by
immutable creation sequence, default 50 and maximum 100. Cursors bind
session, optional channel, last sequence and reminder listing revision.
Any committed reminder row mutation invalidates prior cursors
(`invalid_cursor`); unrelated turns and identical replays do not.

A reminder has `id, channel, createdBy:"agent"|"host", creatorId?, policyNames,
schedule:{at}, text, state, nextRunAt, acceptedAt, expiresAfter, expiresAt`
and optional `lastRunAt, lastOccurrenceId, noticeId, blockedReason`.
States are active, paused, blocked, done, cancelled and expired. Only
active rows have nextRunAt. Absolute instants are UTC ISO strings and
stored as canonical millisecond ISO. The owning host supplies the original
acceptedAt for its delayed intent. Reject anchors more than 30 seconds
ahead of the harness clock. Allow historical anchors. Require at least
120000 ms lead relative to that anchor, including on schedule edits.
Do not rebase on open or replay. Agent acceptance uses the harness clock.
Expiry is at plus expiresAfter (milliseconds); absent grace is twice lead,
clamped to 300000–86400000 ms, explicit grace is integral in that range,
and null means no expiry. At expiry equality the occurrence expires.
Pause or suspension holds the occurrence without extending expiry.

Agent tools reserve `schedule_reminder({schedule,text,expiresAfter?})`,
`list_reminders({after?,limit?})`, and `cancel_reminder({id})`. The schedule
is strictly `{at}` or `{in}` with a positive integer plus m/h/d. Convert
relative input once. Derive channel, creator and taken policy names.
Creation returns `{id,nextRunAt}` and deduplicates by creating invocation
before resolving the relative time. Cancel returns `{id,alreadyQueued}`.
Use checked offered-tool admission and the ordinary permission gate.

## Startup, replay and delivery

Each result is `{ reminderId, changeId, outcome:"applied"|"blocked",
reason?, reminder?, alreadyQueued? }`. Applied includes current row as of
that receipt. Block reasons are invalid_policy, channel_missing,
channel_retired, invalid_schedule, limit_exceeded, conflict, not_found,
stale and invalid_state. Validate both startup batch shapes before either
mutates. Cap reminder batches at 100. Compare the normalized request with
the receipt indexed by (reminderId, changeId) before checking high water.
Replay exact receipts, including blocked ones; changed arguments conflict.
An unseen lower version is stale. Retain receipts and high water for the
session lifetime. A new higher create with identical original definition
is applied; changed definition conflicts. Cancel of a terminal known row
is applied without changing its terminal state. Update of a terminal row
is blocked. A blocked invalid-policy reminder rechecks on explicit update
or resume against the active configuration.

Recover, apply channel changes, apply reminder changes in order, process
due work, return the open response, then release scheduling. The inspection
fence permits no writes or firing. A one-off commits its notice acceptance
and terminal advancement in one transaction; cancellation and firing order
by those commits. IDs are `reminder:<id>:<canonical-at>` for the occurrence
and `reminder-notice:<id>:<canonical-at>` for the external notice. Reuse
that pair after restart. Attribute the notice to the reminder and retain
origin policies. Unknown policy blocks; retirement cancels; suspension
holds. Expiry queues no notice. Due reads use indexed batches of at most
100; yield between batches after startup, re-arm when work remains.

Publish after commit: channel `reminder_changed { reminder }`,
`reminder_fired { reminderId, occurrenceId, scheduledAt, firedAt, noticeId }`,
`reminder_cancelled { reminderId, by:"host"|"agent"|"channel_retired" }`,
and `reminder_expired { reminderId, occurrenceId, scheduledAt, expiredAt }`.
A fired event means queued. Reconcile through saved rows and ordinary
inbox/turn reads rather than replaying historical events.

## Deadline and stop

Executable open returns `nextDueAt: string|null` and
`reminderRevision: number`. Session event
`reminders_due { nextDueAt, revision }` uses the same wake revision.
Start at zero/null. Persist value and increment only when the earliest
eligible instant changes, in the same owner transaction as its cause.
Reconcile on recovery before returning executable open. Equal revision
with a different instant is a conflict; ignore older revisions. Only a
replacement session identity resets the fence. Paused, blocked and
suspended work has no wake deadline. Standalone owns one live timer and
has no automatic idle stop or cold wake.

`session/stop { ifIdle:true, unlessDueWithinMs? }` defaults the window
to zero (nonnegative safe milliseconds). It returns
`{stopped:true}` or `{stopped:false,reason:"busy"|"next_due_soon"}`.
Busy means running turns, runnable waiting inputs or pending approval.
An eligible deadline at or before now plus the window blocks stop.
Check and commit the stop fence synchronously under the same owner as
admission and reminder firing, then release the timer and notify.
An admission ordered first can prevent the stop; an admission ordered
after a successful stop cannot run. Empty params preserve unconditional
stop and its existing response.

## Compatibility and verification

Use SQLite format 7 and logical archive 6, keeping the envelope unchanged.
Migrate formats already supported to empty reminder state under recovery.
Export records, receipts, wake value/revision and listing revision with
the logical session; import and validate them atomically. Rebuild indexes
from committed rows. Older binaries must reject the new executable format
rather than silently ignoring due work. Verify memory/SQLite parity,
timer and cancellation races, atomic crash boundaries, bounded reads,
archive round trip, startup order, replay and revision conflicts, and
real stdio cold-wake acceptance per the plan. R-H3 covers the host
supervisor and its accepted missed-deadline crash window.
