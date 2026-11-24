# Brief R7: reminders, library side (steps 0-2), harness-free

Owner: cod2a (implementer), clad2a (reviewer), core-p (gatekeeper). Branches from alpha `f0eb7d8`: `reminders-r7`
(implementation), `reminders-r7-reviews` (reviews). Plan: `../11-24-PLAN-reminders-acp-client.md` (revision 5 and its addenda;
read all of it, the addenda override the earlier text). Spec: `../../11-23-SPEC-reminders-and-routines.md`.
Nothing here touches the harness wire: no `reminderChanges` sending, no timers, no stop calls (those are R8).

## Part 1: step 0 report (STOP and report before building)

Write `reports/11-24-REPORT-R7-grounding.md` and send it to core-p; do not start Part 2 until core-p replies. Cover:
host start/stop paths in `src/native/host.ts`; where the store, the wake index and the later timer belong; the proposed shape of
the `reminders?` repository and how it sits next to `channels?` in `src/persistence/channels.ts` and the SQLite migrations
(schema 21 -> 22); how `expiresAfter` (omitted, duration, `null`) resolves to an absolute expiry at acceptance and is stored with
the change; how pause and resume are represented (update payloads, field spelling is Gate 1, so isolate it in one adapter);
the typed errors; protected-file line counts and which protected files you expect to touch (ceilings in the plan notes: do not
grow `agent-session.ts`, `host.ts`, `controller.ts`, `client.ts`, `conversation-manager.ts`, `agent.ts`, `metering/engine.ts`).

## Part 2: steps 1 and 2 (after core-p approves the report)

Step 1, store: optional `reminders?` repository (+ `capabilities.reminders`), SQLite schema 22 with an upgrade test from 21, and a
memory implementation. Tables: ordered per-reminder changes (`changeId` strictly increasing per reminder; states pending,
maybe_sent, applied, blocked(reason); an entry is IMMUTABLE once maybe_sent; coalescing only among never-sent entries; a cancel
supersedes a never-sent create or update; an edit after a possibly-sent create is a NEW update with a higher changeId; an
acknowledgement clears only the newest sent changeId; a blocked outcome stays visible until corrected or `discardBlocked`; no
local expiry of unresolved entries); a cache of last-confirmed reminders; a wake index (reported `nextDueAt` + revision, derived
effective wake; an older revision never replaces a newer one). Conversation delete removes entries and cache rows in the same
transaction.

Step 2, model and validation: `Reminder` type; `conversation.reminders` (create, get, list, update, pause, resume, cancel,
`discardBlocked`); `agent.reminders.list()` (paged); `conversationCapabilities.reminders` (true native, false ACP with a typed
error). Local validation before any write: one-shot (`at`, or `in` converted to an absolute `at` at acceptance) due at least 2
minutes after acceptance; `every` at least 10 minutes (`cron` is validated by the harness only); `every` without `startAt` gets
an absolute `startAt` resolved once at acceptance; `expiresAfter` omitted (default grace = 2x lead for one-shots, 2x interval
for routines, clamped to 5 minutes..24 hours), a duration, or `null`; the resolved absolute expiry is stored with the change and
never recomputed on resend; narrower consumer authorization and optional additional policy names (host writes are host-attributed;
the channel policy is never copied); the minimums, caps and grace bounds come from one config object so R8 can fill them from
`initialize` (use the defaults above when not advertised); typed errors incl. `reminders_unavailable` (harness stopped and no
`reminders?` repository). Harness-running path: a seam (interface) for the live request, implemented in R8, so tests use a fake.
Harness-stopped path with the repository: one transaction writing the change and the wake index, `state: "pending"`. Events
(created, changed, confirmed, blocked, cancelled) on the existing conversation event path. Lists with the harness stopped: cache
plus pending; blocked stay listed.

## Tests and gate

Repository tests (coalescing table, freeze after maybe_sent, edit-after-possibly-sent becomes update, clear-only-newest,
older-revision rejection, wake recompute, transactional delete), the 21 -> 22 upgrade test, validation tests for every limit and
boundary (1:59 vs 2:00, every 9:59 vs 10:00, grace clamps at both ends), a crash-retry test with the same changeId twice. Each new
test about 20x in isolation; full suite and typecheck on a clean `git archive` copy with `TMPDIR` on `/dev/shm`; no snapshot
changes; protected files not grown. Report to core-p with commit SHAs; clad2a then reviews on the `reminders-r7-reviews` branch
(review via git archive, never edit `src/`, prove new tests fail on the old code).

Out of scope: any wire, timer, stop or idle code; routines beyond local validation; docs (step 8).
