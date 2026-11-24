# 0032 — Routine schedules and unattended admission

## Problem and choice

Extend the 0031 notice path with recurrence. Reject checking only the next
pair of cron instants and replaying an unbounded backlog. Use the ten-minute
minimum in the harness SPEC and PLAN (superseding the older five-minute
harness proposal), bounded calendar selection and durable turn admission.

## Schedule and wire

The existing methods, startup batches, receipts, deadline fields and agents'
tool names stay. In routine create and schedule replacement, accept
`{every: positive integer milliseconds, startAt?: UTC instant}` or
`{cron: string, timezone: string}`, each with optional `count` (positive safe
integer) **or** `until` (inclusive UTC instant). The anchor remains the original
command's `acceptedAt`. An interval first runs at explicit `startAt` or
anchor plus every. Cron starts at the first match strictly after the anchor.
Any first occurrence must be at least ten minutes after the anchor. An edit
replaces the remaining recurrence from its own anchor and resets its count,
without resetting overlap or reusing a processed instant. Kind cannot change.
Text, grace, pause and missed-run or overlap edits do not reset the calendar or
count. Original channel and origin policy remain immutable as in 0031.

Cron has five numeric fields (minute, hour, day, month, weekday with Sunday
0), wildcards, lists, inclusive ranges and positive steps on a wildcard or
range. Both day fields must match. No seconds, names, macros or extensions.
Use bundled versioned IANA data, accept zone names and aliases from that
bundle only, and persist the chosen canonical zone and data version. Reopen
and import must retain those rules or refuse execution without reinterpreting
the schedule. A gap skips the nonexistent local time and consumes no count.
A fold uses only the earlier UTC instant and consumes one count.

For intervals require every >= 600000. For cron, check the ordinary
time-of-day spacing (including the midnight wrap) conservatively with all
allowed clock times, regardless of date predicates. Then check actual adjacent
matches straddling each transition, including the predecessor and successor
outside the transition day. Check the explicit transition history and one
complete Gregorian 400-year cycle of the recurring zone tail, with boundary
pairs, or the constant-offset tail. Refuse when a zone tail cannot be proved
or a pair is less than ten minutes apart. This may reject some safe calendars
under the conservative daily check. Never accept based on a rolling sample.

Routine creates and edits may set `missedRuns: "coalesce" | "skip" | "each"`
and `overlap: "skip" | "queue"` (defaults coalesce and skip). Routine rows
add these fields and `remainingCount` when counted. Row `expiresAfter` is
the resolved grace of the next occurrence, or null for explicit unlimited
grace or no next occurrence; `expiresAt` is its absolute expiry or null.
Expiry provenance stays internal. Default grace is twice the interval to
the *next calendar match*, ignoring count, until and disposition. Clamp to
5 minutes–24 hours. Use explicit duration or null unchanged. Freeze the
grace for a selected instant before enqueue and expire at equality. For a
terminal row both next timing fields are null. One-off fields keep 0031
semantics and receive no routine fields.

## Occurrences and bounded delivery

Every concrete instant processed consumes one count, including skipped,
expired, overlapped, coalesced and guard-blocked occurrences. A paused or
suspended routine does not advance until eligible again. For a late batch,
separate expired instants first, then apply missed-run policy to the
remaining backlog strictly before the wall-clock minute containing now.
Skip consumes it without enqueue. Coalesce enqueues one notice with the
number represented and latest scheduled instant. Each queues at most the
latest 10 live missed instants per routine per eligibility episode and
reports the older discarded count. An episode freezes its cutoff across
batches and crashes. Current-minute due occurrences use the normal path.
A catch-up range has a compact disposition with its count and endpoints;
no per-instant write for discarded ranges.

Seek and count by indexed calendar ranges (arithmetic for intervals and
calendar rank/select for cron). All instants at or before now minus 24
hours can be expired as a range when grace is finite. Inspect at most the
144 candidates in the remaining 24-hour interval per routine at the minimum
spacing, including variable cron grace. Unlimited grace uses rank/select
for the entire missed range. Cap each owner transaction at 100
dispositions including ranges and attempted enqueues. Startup runs one such
batch. Further batches yield between transactions and report remaining
eligible work via the existing wake revision and deadline. Process in
scheduled UTC order by a disposition's first instant, then routine
creation order for equal instants. Notice attribution uses its
representative instant even when its disposition covers an earlier range.

The occurrence and inbox IDs are `reminder:<id>:<canonical-at>` and
`reminder-notice:<id>:<canonical-at>`. Coalesced notices use the latest
represented instant. Persist a monotonically advanced processed-through
instant even across schedule edits. Preserve the notice-to-item-to-turn
link through take and reopen. Default overlap skips when any preceding
notice for the routine is still received or belongs to a running or
checkpointed turn. Withdrawn notices and terminal or recovered-interrupted
turns release overlap. Queue uses ordinary admission and inbox rules.
Expose compact dispositions on a post-commit channel
`routine_disposition { reminderId, firstScheduledAt, lastScheduledAt, count,
reason }` with reason `missed | catch_up_limit | overlap | expired | unattended_limit | coalesced`.
Ordinary queued notices still emit 0031 reminder_fired.

## Unattended guard

The owning host or standalone operator enables the guard through immutable
session configuration `limits.unattendedTurns` (positive safe integer).
Initialize advertises implementation support as
`capabilities.unattendedTurnGuard: true` and `capabilities.routines: true`
only once the guard is implemented. Advertise `minIntervalMs: 600000`,
`maxActiveRoutinesPerChannel: 20` and `maxRoutineCatchUp: 10` in
reminderLimits. Executable open adds
`unattendedTurnGuard: { maxConsecutiveTurns: number } | null` when supported.
Consumers require both capabilities and a non-null effective guard before
authoring routines. Reject routine activation without it as
`blocked / unattended_guard_required`. Count active rows per channel
transactionally on create and resume, including held active rows.

When configured, the guard counts consecutive turns begun per channel with
no owning-host participant input in the initial taken group. Only actual
participant inbox items reset the counter, never notices, approval, or text
claiming human input. The host must use the notice path for automated work.
Check and update in the begin/take transaction before inference; an
interrupted turn still spends its slot. Resume of the same checkpoint spends
no new slot. When exhausted, queue admission cannot buy another turn: due
routines without runnable participant input record unattended_limit and do
not enqueue; ordinary already queued notices remain pending until a
participant can be taken with them. Blocked backlog alone is not runnable.
Guard-disabled sessions preserve one-off behavior. Existing policy and usage
accounting still apply to all admitted work.

## Commit traces and compatibility

Persist notice acceptance, disposition, calendar advance, count and wake in
one transaction. Before commit a replacement owner recomputes the decision;
after commit it observes the advanced cursor and existing notice, never a
second enqueue. Cancel/edit first means old-calendar work cannot commit;
occurrence first means its notice survives the edit or cancel. If prior-turn
completion commits before the overlap check the occurrence can enqueue; if
overlap commits first, later completion does not undo the skip. Ready
statuses, wake notifications and startup release follow 0031 and immediate
checkpoint resume follows 0014.

Use a lazy format 8 and archive 7 because routine rows, guard counters and
receipts must not be executed by an older one-off reader. Activate atomically
on the first durable routine-specific state (including blocked receipts) or
guard configuration commit. No eager upgrade; inactive 0031 format 6/7 and
archive 5/6 stay unchanged. Envelope stays 1 and retains older supported
inputs. Verify parity, calendar boundary pairs, exact expiry, bounded long
outages, both commit orders, rollback, restart, and real stdio with two
occurrences plus a guarded or overlapping recovery case before releasing R9.
