# Brief R8: reminders, wire, wake timer, idle stop (one-offs only)

Owner: cod2b-t (implementer), clad2a-s (reviewer), core-p (gatekeeper). Branches from `pre-alpha-r7` (`4dc6e79`, R7 included;
alpha will contain it once the user merges): `reminders-r8` (implementation), `reminders-r8-reviews`. Plan:
`../11-24-PLAN-reminders-acp-client.md` (revision 5, addenda rounds 3-9; addenda override). THE WIRE CONTRACT is harness
decision 0031, released and approved as `34969fd9` (ref `aiagent/haurness-rh1-approved`), copied verbatim in
`../contracts/0031-one-off-reminders-34969fd.md`: it overrides every earlier assumption in the plan and in R7. Scope is steps
3-5 (wire and reconcile, wake timer, idle stop) for ONE-OFF reminders (`schedule: { at }`). Routines, `every` and `cron` are NOT
in scope. No real-stdio harness exists yet (R-H2 will come later): test against a scripted fake harness written from 0031 only.

## Part 1: conformance report (STOP, report, wait for core-p's go)

`reports/11-24-REPORT-R8-conformance.md`: a table of every R7 shape against 0031, with the proposed change and files touched.
Must cover at least: create payload `{ channel, schedule:{at}, text, acceptedAt, policyNames?, expiresAfter? }`; update as a
nonempty patch of `text`, `state: active|paused`, `schedule:{at}` (with `acceptedAt` exactly when schedule is supplied) and
`expiresAfter`, cancel `{}`; `expiresAfter` on the wire is integral MILLISECONDS, omitted for the default (the harness computes
2x lead clamped 300000..86400000 from the stored anchor), a number when explicit, null for none; local expiry display must come
from the harness row's `expiresAt`, not from R7's local resolution (a grace-only edit uses the STORED lead anchor, which differs
from R7's "re-resolve at that edit's acceptance"); block reasons now include `stale` and `invalid_state`; `reminderLimits` from
`initialize` (`minLeadMs`, `minIntervalMs`, `maxActiveRoutinesPerChannel` = 0 means routines DISABLED, `minExpiryGraceMs`,
`maxExpiryGraceMs`, `expiryMultiplier`) into the R7 limits object; the harness rejects `acceptedAt` more than 30 s ahead of its
clock; events `reminder_changed`, `reminder_fired`, `reminder_cancelled { by: host|agent|channel_retired }` and a SEPARATE
`reminder_expired` plus state `expired`; the open response's `reminderChanges` outcomes, `nextDueAt`, `reminderRevision` and the
first bounded list page (`reminders`, `remindersNext`); batch cap 100; list cursors invalidated by any committed reminder mutation
(`invalid_cursor`); session-lifetime receipts. Also say how an offline `every`/`cron` create behaves while the harness disables
routines (proposal: refuse locally with a typed error; keep the journal untouched).

## Part 2: build (after the go)

Step 3, wire and reconcile. In the executable open (`session/create` and `session/open`, never `session/load`), after the channel
changes in the same request, send `reminderChanges` in submitted order, each entry marked `maybe_sent` first, at most 100 per
request (hold the rest for the next open or a live write). Results are matched by (reminderId, changeId): `applied` clears only the
newest sent changeId and updates the cache from the returned `reminder`; `blocked` is recorded with its reason and stays visible
(`conflict` and `stale` are surfaced as defects: acp-client never sends a lower id than one recorded as sent); `invalid_state`,
`not_found`, `channel_retired`, `invalid_policy`, `invalid_schedule`, `limit_exceeded` are recorded as blocked. Live writes use
`reminder/change` with the same entries; reads use `reminder/get` and `reminder/list { channel?, after?, limit? }` (default 50,
max 100). The open's first list page seeds the cache; the rest by paging; `invalid_cursor` restarts the sweep within a bounded
budget, then the cache stays last-confirmed and flagged unreconciled; a sweep never feeds the wake. `nextDueAt` and
`reminderRevision` from the open and `reminders_due { nextDueAt, revision }` events go through the R7 fence (session-keyed: accept
newer, ignore older, ignore and LOG an equal-revision mismatch; only a replacement session resets). Events update the cache and
reach consumers: `reminder_changed`, `reminder_fired` (deduplicated by occurrenceId/noticeId; "fired" means queued),
`reminder_cancelled`, `reminder_expired`. Read `capabilities.reminders` and `reminderLimits` from `initialize`: absent means
reminders unsupported (typed error), and `maxActiveRoutinesPerChannel` 0 means routine schedules are refused. Bind the R7 live
request seam to the live host (it has no AgentConfig binding yet) so a running-harness create is a `reminder/change` confirmed on
the result; a stopped-harness create stays journaled (R7) and is sent at the next open.

Step 4, wake timer (SQLite owner only). A host-owned timer armed from the wake index (reported `nextDueAt` and the validation wake
`min(acceptedAt + 2 min, dueAt)` for unresolved pending/maybe_sent changes); at expiry call `ensureStarted()` (single-flight with
any other start); opening is enough, no wake request. Clamp each wait to at most 60 s and recheck the wall clock on every wake (an
early wake or a backward clock jump re-arms without acting); one explicit timer (no `AbortSignal.timeout`, Bun 1.3.14 bug).
`harness.stop()` keeps the wake armed; `agent.close()` clears it and the stored wake remains; construction with an overdue index
starts the harness once, at once. A wake that cannot resolve (a past validation wake with an unresolved entry, a failed start) is
rate-limited by the existing restart budget (3 in 60 s) and then surfaces `HarnessUnavailableError`; it must NEVER spin. Injectable
clock and timer.

Step 5, idle stop. `harness.idleStopMs` (off by default), per-Agent with conversation overrides: the window passed is the largest
among conversations with a pending reminder. Stop with `session/stop { ifIdle: true, unlessDueWithinMs }` (window defaults to 0 on
the harness). `{ stopped: true }` then arm the wake for the next due time; `{ stopped: false, reason: "busy" | "next_due_soon" }`
changes nothing and retries later with backoff. acp-client also requires no turn running or held, no pending permission, no held
channel or reminder change on its own side. Activity after a stop starts the harness again once (race-safe).

## Tests and gate

Scripted fake harness built ONLY from 0031 (shared fixture file, so R-H2 can later run the same expectations against the real
one): ordering (channel then reminder changes), replay of exact receipts, changed payload `conflict`, unseen lower `stale`, blocked
visibility, `invalid_cursor` restart budget, fence cases (equal-revision mismatch, replacement session), event dedupe, batch cap
100 chunking, expired state and event, `maxActiveRoutinesPerChannel: 0` refusal, absent capability. Timer tests with an injected
clock: fire, rearm, 60 s clamp, early wake, backward jump, race with a manual `start()`, race with `close()`, `stop()` keeps the wake,
overdue at construction, failed start and past validation wake do not spin, owner-only arming. Idle-stop tests: each non-idle reason,
window boundary, stop then wake, stop racing a send. Gate: typecheck + plain `bun test` on a clean `git archive` copy with
`TMPDIR` on `/dev/shm`; new tests about 20x in isolation; 35 snapshots unchanged; protected files not grown (extract first). Also
carry in: assertion that update/pause/resume while a cancel is pending/maybe_sent is refused with `conflict`; note the widened
`AgentSessionEvent` union for the release notes. Report with commit SHAs; true results only, flakes included. Message core-p before
going idle.

Out of scope: routines, cron, the unattended guard, real stdio (R-H2), documentation (step 8).
