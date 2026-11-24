# Reminder and routine tools

Date: 2026-11-24

Status: Proposed for v1.

A reminder schedules agent work on a native channel. A routine repeats it. The
harness owns the schedule and queues due work through the durable inbox notice
path. An optional host, initially acp-client, can start a stopped harness at the
next deadline. Standalone sessions can schedule, cancel and run reminders
while open, and catch up when reopened.

## Agent tools and host controls

| Agent tool | Behavior |
| --- | --- |
| `schedule_reminder({ schedule, text, ...routineOptions })` | Store the instruction and schedule for the current channel. Return the reminder ID and next run time after the commit. |
| `list_reminders({ after?, limit? })` | Return a bounded page of reminders for the current channel, including their state and next run time. |
| `cancel_reminder({ id })` | Cancel future occurrences. Report whether an occurrence was already queued. A queued occurrence follows the normal inbox lifecycle. |

The harness derives the channel, creator and policy names from the calling turn.
The tool arguments carry no channel or policy override. The tools use the normal
tool catalog, permission gate and typed results. Store the ID of the creating
tool invocation with the reminder so retrying a committed call returns its
original receipt. Listings use an opaque cursor and stable ordering.

The owning host can create, get, list, update, pause, resume and cancel reminders
through the same harness operations. A host write names the destination channel.
A host list can cover one channel or the whole session. The host supplies any
additional policy names, which the harness validates at creation. acp-client
maps these operations to `conversation.reminders` and an Agent-wide list.
The consumer capability applies to native conversations.

## Stored state and delivery

Store each reminder in session storage with its ID, channel, creator, policy
names, schedule, text, state and next occurrence. Use the existing persistence
extension for durable sessions and equivalent in-process behavior for memory.
Store absolute UTC instants. Convert a relative input such as
`{ in: "30m" }` once, when accepted. acp-client resolves it before persisting a
stopped-session intent. Replaying an intent preserves its original due time.

The harness owns an index of eligible deadlines and arms one timer for the
earliest deadline in the session. Recalculate after a committed reminder or
lifecycle change. On timer expiry, read the due records and recheck eligibility
under the session owner. After a restart, rebuild the timer from committed state.
A suspended or suspending channel or session holds due work and contributes no
wake deadline. Resume makes held work eligible. Retirement cancels future work.
A paused reminder also contributes no wake deadline.

Use a stable notice ID derived from the reminder ID and the scheduled instant.
Commit notice acceptance and occurrence advancement together, including the
terminal state of a one-off reminder. Retries use the same occurrence and notice
IDs. Cancellation and acceptance are ordered by their commits. The existing
notice path wakes an idle channel or steers a running turn at its next inference
boundary. A fired event means that the notice was queued. The eventual turn
outcome follows the existing channel events.
[External notices](../../channel-messaging/0001-DESIGN-external-notices/SPEC.md)

A reminder keeps its originating policy names. At firing, the destination policy
and inherited names resolve against the active configuration. Record and report
an invalid-policy block and remove it from the wake calculation until corrected.
Channel and reminder attribution travel with the notice.

## Shared wake contract

On an executable session open, before enabling the timer or handing work to the
turn scheduler:

1. Recover committed session state.
2. Apply pending channel changes in their existing startup order. Apply pending
   reminder intents in their submitted order against the resulting channel state.
3. Process eligible due reminders using the resulting state. Return the intent
   outcomes and the next eligible due time, or null when none exists. Release
   eligible work to the normal scheduler once the open fence is complete.

An offline cancellation or pause accepted in step 2 therefore wins over an
overdue occurrence that has yet to be queued. A committed notice is already
owned by the inbox. Inspection-only opens perform no reminder writes or firing.
An open retry with the same intent IDs returns their recorded outcomes without
reapplying edits or queuing duplicate notices. Each mutation intent has an ID
distinct from its target reminder ID. Reusing that intent ID with changed
arguments is a conflict. A state-dependent rejection is reported as blocked with
a reason. acp-client keeps it visible until corrected or removed.

Return `nextDueAt` and its revision on executable open and publish the same data
when the earliest eligible deadline changes. Persist the revision so it never
decreases on reopen of the same session. For that session, one revision always
identifies one deadline value, including null. The host applies the same
comparison to open responses and events: ignore older revisions, accept newer
ones, and flag a conflicting value at the same revision without replacing the
stored value. An executable open repairs a missed update when it returns a newer
revision. Only a separately established replacement session starts a new fence.
Report firing with the
reminder ID, occurrence time and notice ID, and cancellation with the reminder
ID. The open response is authoritative for reconciling a missed update.

acp-client persists one next reported deadline per Agent alongside pending
reminder intents. Its effective deadline is the minimum of that value and any
eligible deadline supplied by a pending create or edit. At the deadline,
acp-client uses lazy start. A running harness already has its own timer. A
stopped harness processes due work on open. This requires no wake RPC and no
periodic container starts. The consumer can list cached records plus pending
intents without opening a stopped harness. The cache is last-confirmed state.

Offline timing depends on a running acp-client supervisor. If the harness
commits a reminder or advances a deadline before acp-client persists the new
wake time, a crash can leave the host with a stale deadline. This is an accepted
v1 window. The saved reminder is recovered at the next eligible open and can
run late. The harness may acknowledge its local commit before the host
persists the wake. A wake can also start a cold container, which adds startup
time before the turn runs.

## Routines

One-offs use `{ at }`. Routines add `{ every, startAt? }` and
`{ cron, timezone }`, with optional `until` or `count`. Calendar schedules use
the specified timezone. Each concrete occurrence has its own scheduled UTC
instant and stable ID. The routine contract decision must define daylight-saving
gaps and folds and how skipped occurrences interact with `count`.

On reopen or resume, the proposed default is to coalesce elapsed occurrences into
one notice with the number missed and the last scheduled time. The routine can
also skip elapsed occurrences or request each occurrence. Processing and
catch-up must be bounded so a long outage cannot monopolize open. The proposed
overlap default skips a due occurrence while a prior occurrence of that routine
is waiting or running. The queue alternative follows ordinary channel
scheduling. The routine contract must define how the prior occurrence remains
identifiable through inbox take, turn completion and restart.

Apply the same scheduling minimums to agent tools and host requests. A one-off
must be due at least two minutes after acceptance. Repeating schedules must
leave at least ten minutes between consecutive occurrences. The harness checks
this for both intervals and cron and refuses an invalid schedule. The contract
decision defines how cron validation establishes the minimum across calendar
and timezone transitions. Advertise both minimums, the active routine cap per
channel, and the expiry defaults, including the grace floor and ceiling, during
initialization so consumers can validate locally. The harness remains
authoritative when it accepts a schedule.

The default expiry grace starts at the scheduled occurrence. For a one-off,
use twice the lead time from acceptance to that instant. For a routine, use
twice the interval for the occurrence. Clamp the resulting grace to at least
five minutes and at most 24 hours. A two-minute lead gets five minutes of grace.
Keep the one-off expiry stable across retries. The contract review must settle
the interval used for calendar schedules and how to report expired occurrences.
An explicit `expiresAfter: null` permits late delivery. The catch-up and overlap
defaults remain subject to contract review.

Scheduled turns use ordinary usage accounting. The planned unattended-turn
guard is a prerequisite for enabling unattended routines.

## Implementation and acceptance

1. Land the harness contract decision first. Implement one-offs, the tools,
   durable notice enqueue and open catch-up behind the tools, storage and
   scheduling contracts. Use a controlled clock to test detached wake,
   suspension, retirement, cancellation around the deadline, and restart on
   either side of notice acceptance. Cover memory and SQLite.
2. Add the startup intent and deadline contract with in-process and real stdio
   conformance. In the joint acp-client gate, stop a harness with a saved reminder
   and verify one lazy start and one notice to the original channel. Cancel an
   overdue reminder while stopped and verify zero notices on open. Exercise
   replay after a lost open response, a missed deadline event, and the accepted
   crash window. acp-client owns pending intent persistence, cache, capability
   wiring and idle-stop policy.
3. Add routines on the same contract after the routine decisions. Test calendar
   and interval schedules, missed runs, overlap, limits, and replay of a committed
   occurrence.
