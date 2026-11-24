# Brief R9: reminders, routines on the library side (every, cron, count/until, guard)

Owner: Part 1 cod2a-r, Part 2 cod2b-t after R8.5 (typed client) lands; clad2a-s reviews; core-p gatekeeper. Branches `reminders-r9`
(implementation) and `reminders-r9-reviews`, from alpha `4dad65e` (rebase/merge R8.5 `reminders-typed` before Part 2). THE CONTRACT is
harness decision 0032, released as `973a522` (ref `aiagent/cod1a-reminders-rh4`), copied verbatim in
`../contracts/0032-reminder-routines-973a522.md`; 0031 (one-offs) still applies. The harness runtime is not approved yet: Part 1 is
documentation, Part 2 builds against a scripted peer written from 0032 only; the joint real-stdio R9 acceptance waits for the
independently approved runtime SHA (haurness-l will send it).

## Part 1: conformance report (documentation only; STOP and wait for core-p's go)

`reports/11-24-REPORT-R9-conformance.md`: table of the R7/R8 shapes (src/native/reminders/*, host, recovery, config, public model,
docs) against 0032, with the proposed change per row and files touched. Must cover at least: schedule union `{ every, startAt? }` and
`{ cron, timezone }` each with `count` XOR `until` (validation of both-present and non-positive values); first occurrence >= 10 min
after the anchor; kind cannot change on edit; an edit replaces the remaining recurrence from its own acceptedAt and resets the count;
text/grace/pause/missedRuns/overlap edits do not; `missedRuns: coalesce|skip|each` and `overlap: skip|queue` (defaults); routine row
fields (`remainingCount`, `missedRuns`, `overlap`, next-occurrence `expiresAfter`/`expiresAt`, both null when terminal); the default grace
rules for routines (2x interval to the next match, clamp 5 min..24 h) vs R7's local "harness default" marker; cron grammar (5 numeric
fields, AND of day fields, no names/macros/seconds) and IANA timezone (canonical zone, data version) and what acp-client validates
locally vs leaves to the harness; `reminderLimits` (`minIntervalMs` 600000, `maxActiveRoutinesPerChannel` 20, `maxRoutineCatchUp` 10) and
how `routines_unavailable` changes (removed only when the harness advertises `capabilities.routines` AND `unattendedTurnGuard`, and the
open result's `unattendedTurnGuard` is non-null; otherwise keep refusing with a clear error); the guard: immutable session config
`limits.unattendedTurns` at create or one-time enable at open (new AgentConfig option, where it flows, `invalid_config` on a differing
value, never on inspection opens; proposal: no default = routines unavailable), `blocked / unattended_guard_required`, what acp-client
must NOT do (it never claims human input, uses the notice path); new block reasons and request-level errors (retryable
`storage_failure` on create/edit with NO durable receipt: what the journal state, retry and the open batch do; `invalid_config`);
the `routine_disposition { reminderId, firstScheduledAt, lastScheduledAt, count, reason }` channel event (new public event kind in
the union, persistence/dedupe, reasons missed|catch_up_limit|overlap|expired|coalesced) next to 0031 `reminder_fired`; the cold wake with
guard-exhausted channels (harness removes their routine deadline from nextDueAt: confirm acp-client needs no logic of its own) and the
validation wake for routine creates; consumer API additions (`create` with routine options, `update` of schedule/missedRuns/overlap,
count/until, listing fields), local validation vs harness validation, the 15-minute vs 10-minute minimum (now ONE minimum 10 min),
fixture/scripted-peer requirements, docs/migration/changelog updates, tests, protected ceilings (host.ts 909/909: zero net lines).
Also list contract ambiguities to send to haurness-l.

## Part 2: build (after core-p's go, after R8.5 is merged into the branch)

Library API and validation for routines, wire adapter (create/update payload unions per 0032), cache/rows, events (`routine_disposition`),
guard configuration plumbing, capability/limits negotiation, journal/retry semantics for the request-level errors, scripted peer
fixtures from 0032 (shared with the later real-stdio file), docs and migration (guide sections for routines and the guard, error-code
table, event union, limits), tests and mutation-strong coverage. Gate: typecheck + plain `bun test` on a clean `git archive` copy with
TMPDIR on /dev/shm; new tests 20x isolated; 35 snapshots unchanged; protected files not grown; no `src/native-harness` edits.

Out of scope: harness code, the real-stdio R9 acceptance (waits for the approved runtime), the CLI.
