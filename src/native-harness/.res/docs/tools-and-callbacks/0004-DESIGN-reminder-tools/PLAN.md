# Harness reminder implementation plan

Date: 2026-11-24

Status: Proposed. Reminders are the next harness implementation after timeline
retrieval. Start from the reviewed `aiagent/haurness-l` base at `f0eb7d8`.

Deliver one-off reminders first. A standalone harness can schedule a check,
wake the original channel while running and catch up after restart. acp-client
then supplies the supervisor that wakes a stopped harness. A later gate adds
routines and their unattended execution guard. [Reminder tools spec](SPEC.md)

## R-H1 · Review the one-off contract

- Freeze the requests, tool arguments, wire fields, and advertised capability.
  Put `reminderChanges` on executable `session/create` and `session/open`,
  alongside the existing channel batch. Validate both batch shapes before
  mutation. Apply channel changes, then reminder changes in submitted order,
  then queue eligible due notices, before normal scheduling can begin. An
  inspection fence permits neither reminder mutations nor firing.
- Define the lookup for `(reminderId, changeId)` before the high-water check.
  Exact replay returns the recorded outcome. Changed arguments conflict.
  An older version with no receipt is stale. Pin retention, blocked reasons,
  pause and resume update shapes, and bounded list pages with explicit
  invalidation. Keep stored outcomes for the session lifetime in this version.
- Define the authorized host's original acceptance timestamp for queued offline
  writes, including validation of unreasonable future timestamps and clock
  skew. The two-minute lead check and default expiry use that stable anchor.
  Opening after the deadline must not invalidate an otherwise eligible intent.
  Live agent creates use the harness clock. Pin expiry status and events and
  distinguish expiry from a notice already accepted by the inbox.
- Freeze the wake deadline response and event. Within one session identity a
  revision maps to one value, including null, across reconnect and reopen.
  Define atomic conditional stop, including its response when busy or near a
  deadline. The stop decision must fence new work under the same owner as
  admission. Pin the standalone behavior and backward compatibility for
  callers that use existing unconditional stop.
- Pin the persistence and archive changes, including opening existing databases
  and transferring reminder records with portable sessions. Land the numbered
  contract decision before runtime work. Give core-p the approved revision
  for R8a. The acp-client R7 repository and library groundwork can proceed
  against its separate plan.

## R-H2 · One-off reminders in the harness

| Area | Proposed code ownership |
| --- | --- |
| Contracts | Add a focused reminder contract under `src/contracts/` and extend the tool, storage, event and protocol references there. |
| Records and deadlines | Put memory and SQLite persistence under `src/state/storage/`. Index eligible due records. Commit reminder advancement and inbox acceptance together. Keep edit receipts and the wake revision in durable state. |
| Runtime scheduling | Add a small reminder scheduler outside the kernel, under `src/runtime/`. Inject the clock and timer for tests. Wire it through session assembly in `src/index.ts` and the existing lifecycle hooks. The kernel continues to take inbox notices through its normal scheduling path. |
| Native tools | Add `schedule_reminder`, `list_reminders` and `cancel_reminder` under `src/capabilities/tools/`. Use checked native dispatch from timeline retrieval and derive channel and policy from the calling turn. |
| Host boundary | Extend `src/interfaces/protocol/server.ts`, startup batch handling and `src/interfaces/client.ts`. Use the same assembly for stdio, in-process and standalone configured sessions. |

Use one timer per open session, armed for the earliest eligible deadline.
Re-arm on committed changes, resume or reopen. Closing the session releases
the timer. Use bounded due reads, stable occurrence and notice IDs, and no
whole-session snapshot on the timer path. The wake index excludes paused,
blocked, retired, suspended and suspending work. Recheck lifecycle and policy
at delivery. Failure to publish a wake update leaves the durable reminder
recoverable on a later eligible open, subject to its expiry.

Acceptance uses the same cases in memory and SQLite where applicable:

1. Schedule through a real tool call and verify one attributed notice on the
   original detached channel. Verify the busy-channel path at the next
   inference boundary. Check policy denial and malformed calls before effects.
2. Exercise pause, channel and session suspension, resume, retirement and a
   cancel racing a due occurrence. Test expiry bounds and explicit no-expiry.
3. Crash before and after the atomic notice commit. Reopen and retry, checking
   the notice ID and count. Verify migrated and imported sessions and bounded
   reads on a large reminder set.
4. Verify executable startup ordering, lost-response intent replay, conflict
   and stale versions, bounded listing and cursor invalidation. Exercise the
   deadline revision across reopen and concurrent event delivery.
5. Race conditional idle stop against an inbox admission and a due reminder.
   Verify busy and next-due-soon refusals, then verify a successful idle stop
   with a later reminder still persisted.

## R-H3 · Joint wake acceptance with acp-client

Supply the reviewed one-off implementation SHA to core-p for R8a. Extend the
existing cumulative real-stdio fixture in `test/native/fixtures/`. The scripted
model calls the real reminder tool. Use a controlled clock or scheduler seam
with normal scheduling bounds. Assert the persisted reminder, the attributed
notice and the resulting turn. Keep the timeline phase and exact script
consumption checks.

Use the real supervisor for separate stopped-session cases. Verify exactly
one lazy start and one notice when due, an offline cancellation before open
that queues no notice, recovery after a lost open response, and authoritative
wake reconciliation after a missed event. Test the accepted window where a
persisted reminder can run late if the host never stored its deadline. Verify
that the original acceptance anchor and expiry survive this path and that
an already expired occurrence queues no notice.

## R-H4 · Routines

Review the routine contract separately before R9. Freeze DST gaps and folds,
variable cron intervals, the ten-minute minimum, defaults for missed runs and
overlap, bounded catch-up, occurrence identity across restart and the unattended
guard capability. Add recurrence to the same stores, timer and notice path.
Exercise guard and limit behavior before enabling routines. Add a cumulative
rehearsal phase that proves two distinct occurrences and one recovery or
overlap case.

For each runtime gate, submit the exact revision with both typechecks, focused
conformance, applicable real-stdio acceptance, and full harness and root
results. Integrate the reviewed work into `aiagent/haurness-l`.
