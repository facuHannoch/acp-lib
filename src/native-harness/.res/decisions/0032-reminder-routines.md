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
range. Both day fields must match (AND, including when both are restricted). State
this in the tool schema descriptions and protocol documentation. No seconds, names, macros or extensions.
Use bundled versioned IANA data, accept zone names and aliases from that
bundle only, and persist the chosen canonical zone and data version. Compare versions using the bundled IANA release order. On upgrade, repeat
the admission proof for existing routines against the new bundle inside the
executable open/recovery transaction (on import, before publishing the imported
session). Keep the processed-through instant, consumed count and notice links.
Only recompute unprocessed instants strictly after that fence. If the new
rules, including canonical zone resolution, cannot prove the schedule, keep
its old version and move it to blocked/invalid_schedule, with a durable
invalid_schedule disposition carrying reminderId, old/new data versions
and cause `invalid_schedule | proof_budget`, with no occurrence or count
consumption. A migration budget hit uses proof_budget, retains the saved
version and removes the routine from wake eligibility. Other routines
and the open/import proceed. Reopening with the same target version
reuses the saved disposition and does not retry; an explicit schedule
update or a different target version triggers a new proof. Publish it after commit. An explicit
schedule update can repair it. Refuse a newer version at open or import into
an older reader before any mutation. Inspection-only open makes no changes. A gap skips the nonexistent local time and consumes no count.
A fold uses only the earlier UTC instant and consumes one count.

For intervals require every >= 600000. For cron, check the ordinary
time-of-day spacing (including the midnight wrap) conservatively with all
allowed clock times, regardless of date predicates. Then check actual adjacent
matches straddling each transition, including the predecessor and successor
outside the transition day. Check the explicit transition history and one
complete Gregorian 400-year cycle of the recurring zone tail, with boundary
pairs, or the constant-offset tail. Refuse when a zone tail cannot be proved
or a pair is less than ten minutes apart. Use indexed predecessor/successor
queries around transitions, with work proportional to transition dates and
the bounded allowed daily times, without enumerating the recurrence. Cap
one admission proof at 250 ms measured by a monotonic clock, with checks
between bounded calculation steps. A budget hit refuses the command with a
retryable request-level error (storage_failure) on create or edit, without a
durable receipt or partial mutation. Migration instead commits the
proof_budget disposition described above. An explicit proof failure remains
invalid_schedule. Test the migration budget path on open and import,
including unchanged count, no wake contribution and idempotent reopen. This may reject some safe calendars
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

Agent schedule_reminder accepts the same routine union, count/until,
missedRuns and overlap, with the harness clock as the anchor and the
existing invocation deduplication before resolving a schedule. Apply the
same checked offer and policy admission, guard requirement, spacing proof,
and active cap as for the host. List and cancel can address routines only
in the caller's channel, with 0031 cursor and not_found rules. Agent
arguments cannot supply origin names, creator, channel or acceptedAt.

## Occurrences and bounded delivery

Every concrete instant processed consumes one count, including skipped,
expired, overlapped, and coalesced occurrences. A paused or
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
reason }` with reason `missed | catch_up_limit | overlap | expired | coalesced`.
Ordinary queued notices still emit 0031 reminder_fired.

## Unattended guard

The owning host or standalone operator enables the guard through immutable
session configuration `limits.unattendedTurns` (positive safe integer).
Allow it at create or as a one-time enable on executable open of an existing
session without a guard. On open, durably bind the setting and activate
format 8 atomically before applying intents or starting work. Start the
per-channel counters at zero. Later opens without the field use the saved
value; an explicitly different value is invalid_config before any writes.
Inspection opens cannot enable it. Persist the bound limit independently of
subsequent managed config selection and carry it through archive export.
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
no new slot. When exhausted, a channel with no runnable owning-host participant
input contributes no **routine** deadline and no routine occurrence is
processed. This applies to live and cold wake, including queue overlap.
No unattended_limit routine disposition is emitted. Guard refusal at
turn admission leaves ordinary already accepted notices pending without
spending a slot. Blocked backlog alone is not runnable.

Evaluate eligibility from the counter, channel/session lifecycle, and
whether the next initial take can include a participant item under the
ordinary intake rules. Recompute the routine contribution on participant
admission, withdrawal or take, guard limit reached or reset, and lifecycle
changes, in the transaction committing that cause. Use the existing wake
revision rule: advance only if the aggregate next deadline changes, and
publish after commit. Other eligible channels retain their deadlines. A
participant arrival can restore eligibility before take; only actually
taking a participant resets the counter. If eligibility is lost again,
hold the remaining work without consuming it. When eligible, apply normal
expiry, missed-run limits and stable occurrence IDs to elapsed work.
Guard-disabled sessions preserve one-off behavior and the 0031 one-off wake
calculation is unchanged. Existing policy and usage accounting still apply.


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

Guard acceptance must cover a cold exhausted channel with no deadline,
another channel retaining its own deadline, and participant admission
followed by take/reset and bounded catch-up. Cover withdrawal before take
and a crash between participant admission and reset. Reopen must use the
saved counter and inbox to recover eligibility without a duplicate notice.

## R9 startup and wire clarification

Create and open retain the 0031 ordering and per-entry commit boundary.
Publish the session and bind any guard enable, apply startup channel changes,
then apply reminder entries in order. On a create/edit proof-budget error,
the failing entry has no receipt or partial mutation. Earlier guard enable,
channel edits and reminder receipts survive if committed. Stop at the failing
entry, skip later entries, do not run startup reminder due processing and
do not release unrelated scheduling on that failed request. Explicit
checkpoint resumes retain 0014 behavior. No structured error.data field
identifies the entry or confirms the failure point. The consumer retains
the frozen, unacknowledged batch and retries it exactly with a bound,
including original IDs, anchors and payloads. Durable receipts replay.
If create already published the session, recover through executable open
of the same confirmed session identity, with the frozen intents intact.

Negotiate both initialize capabilities before sending routine configuration.
Absence is an explicit incompatibility. The host can request one-time guard
enable on open after negotiation. An incompatible saved guard value is
invalid_config without a required structured error.data payload. Executable
open confirms effective maxConsecutiveTurns. Include owed pause, cancel and
other non-activating edits in startup so they precede due processing. Hold
create, resume and schedule replacement until executable open confirms the
effective guard, then send them live with their original anchors. Held
activations alone contribute no host wake deadline. Preserve per-reminder
order. Resolve a local intent conflict before sending a later pause or cancel
that must win ahead of an earlier held activation.

A calendar row's schedule.timezone holds its canonical zone. A calendar row
also has top-level timezoneVersion, the version last validated for that
schedule. A migration hold uses state blocked, blockedReason invalid_schedule
and top-level timezoneMigration: { fromVersion, targetVersion, cause }, with
cause invalid_schedule or proof_budget. The row keeps its saved
timezoneVersion until successful revalidation. Successful repair removes
timezoneMigration. The channel event is
routine_migration_blocked { reminderId, fromVersion, targetVersion, cause }.
Publish it after the committing transaction, before the same-commit
reminder_changed carrying that authoritative row. Reopening against the same
target emits neither event again for an already recorded hold. No migration
event is emitted on successful revalidation; reminder_changed carries any
changed authoritative row.

Calendar range routine_disposition events are live and post-commit. They
have no replay or list API and no contractual tuple ID. Publish a
same-commit disposition before its associated reminder_fired. Storage
retains the disposition and migration idempotency independently of whether
a consumer received the event.

A returned interval schedule always contains explicit resolved startAt,
including when omitted on input. A replacement keeps the recurrence aligned
to its new anchor and starts strictly after the persisted processed-through
instant as well as respecting the minimum initial lead. Discard aligned
matches at or below the fence without consuming the replacement count. An
inclusive until before the first eligible instant is invalid_schedule.
Reject an empty bounded replacement as invalid_schedule.

Verification includes create and open proof-budget failures after an
earlier successful receipt, preserved channel and guard commits, skipped
later entries and due work, and exact retry through the same session. Pin
the event order and authoritative migration row, same-target reopen
idempotency, normalized startAt, inclusive until equality, and replacement
fence alignment.

Guard confirmation is connection-local. An executable open on the current
connection must confirm it before held activations may be sent, even when a
reconnect reports the same sessionId. A saved guard confirmation cannot stand
in for that response.

A held create followed by pause on the same ID is sent in that order after
guard confirmation. The create keeps its existing shape. A due occurrence
may commit between the requests and the pause then governs future work.
An owed startup pause or cancel on an existing row runs before startup due
processing, subject to the same-ID order above. A held schedule replacement
takes effect when sent live, so an old-calendar occurrence may commit during
open. Held activation alone supplies no stopped-session wake or launch.
