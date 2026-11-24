# Review: R9 Part 1 conformance report (e7f1f6e on `reminders-r9`) against 0032 and the pin c8facc2

Reviewer: clad2a-s. Read via `git show`; code facts checked on alpha (`4dad65e`) and the R8/R8.5 reminder modules. Reviewed against decision 0032 at `973a522` **and** the approved wire/startup pin `c8facc2`
(`library/contracts/0032-reminder-routines-c8facc2.md`), which adds the "R9 startup and wire clarification" section. No `src/` edits.

Verdict: **the mapping is accurate where it speaks and its questions were the right ones, but it predates the pin and misses 9 client-visible rules. Go for Part 2 with the 12 conditions below.**
Your provisional first-open plan is sound in outline; it needs four additions (section 3), and it breaks one 0031 guarantee for schedule replacement that should be a conscious ruling.

## Facts the report asserts about alpha: verified

`service.ts` refuses `every`/`cron` before any write; `schedule.ts` has the detached interval branch (10-minute interval but the two-minute one-off lead for an explicit `startAt`; implicit start = anchor + interval) and a cron branch that only checks non-blank strings;
`wire.ts` encodes one-offs only; `fromWireReminder` reads `schedule.at`; cron expiry uses the local `harness_default` marker; `AgentConfig.reminders` has only `authorize`/`limits`; `AgentHarnessConfig.config` is forwarded and sent on both open requests;
startup retries a timeout once and strips/quarantines the reminder batch only for `invalid_params`. All true.

## 1. Rules the report maps (and how I found them)

| 0032 rule | Report | Assessment |
|---|---|---|
| Schedule unions, `count` XOR `until` | row 1 | mapped; reject both, bad count, bad until; harness decides inclusive end |
| Anchor, first-occurrence lead 10 min, interval `startAt` default, cron first match after anchor | row 2 | mapped; fixes the 2-minute lead currently applied to routine `startAt` |
| Edit/reset rules (replacement from its own anchor, count reset; text/grace/pause/missed/overlap do not reset; kind immutable) | row 4 | mapped, but "preserving kind" must say who rejects a kind change (condition 3) |
| `missedRuns` / `overlap` and defaults | row 5 | mapped (omit to take the harness default) |
| Row fields, `remainingCount`, next-occurrence grace, default grace = 2x interval to next calendar match | row 6 | mapped |
| Limits (`minIntervalMs 600000`, cap 20, `maxRoutineCatchUp 10`) and capability gating | row 7 | mapped |
| `limits.unattendedTurns`, immutability, `invalid_config` | row 8 | mapped except negotiation-before-send and the retry classification (condition 4) |
| `unattended_guard_required` | row 9 | mapped |
| `storage_failure`, no durable receipt | row 10 | mapped; consistent with the pin's retry rule, but see conditions 5 and 6 |
| `routine_disposition` event | row 11 | mapped; dedupe proposal conflicts with the pin (condition 8) |
| Cold wake, exhausted channel | row 12 | mapped; conflicts with the pin on held activations (section 3) |
| Docs | row 13 | incomplete (condition 12) |

## 2. Client-visible rules not mapped (mostly added by the pin)

1. **`routine_migration_blocked` and the migration row.** The report defers this as an open question. The pin fixes it: event `routine_migration_blocked { reminderId, fromVersion, targetVersion, cause }` published after the committing transaction **before** the same-commit
   `reminder_changed`; the row is `state: "blocked"`, `blockedReason: "invalid_schedule"`, top-level `timezoneMigration { fromVersion, targetVersion, cause: "invalid_schedule" | "proof_budget" }`, with `schedule.timezone` canonical and top-level `timezoneVersion` (kept until revalidation);
   reopening the same target emits neither event again; successful repair removes `timezoneMigration` and emits no migration event. Needs: the new public event kind (widens the union again; allowlist, required-field checks and the stdio filter regex, which only matches `reminder_`/`reminders_` today, must learn `routine_*`),
   the three row fields in the cache and public view, and ordering preserved through the serialized `ordered` chain. The local "terminal" set must keep excluding harness `blocked` so an explicit schedule update can repair the row (it does today).
2. **Interval `startAt` always explicit in returned rows** (also when omitted on input); the library must store the returned value and must not recompute it locally.
3. **Replacement fence and `until`.** A replacement starts strictly after the persisted processed-through instant; aligned matches at or below it are discarded without consuming the count; `until` before the first eligible instant and an empty bounded replacement are `invalid_schedule`; inclusive `until` equality is valid.
   The client cannot know the fence, so only the harness can decide; the library must surface the resulting blocked receipt as a visible blocked view and must not pre-reject a replacement on a locally computed first occurrence (it may only check `until` against the interval's own first occurrence on create).
4. **`invalid_config` carries no structured data**, and a mixed-version host must **negotiate both initialize capabilities before sending any routine configuration**; absence is an explicit incompatibility (never silently drop the configured guard).
5. **Disposition and migration events are live-only, no replay or list API, no contractual tuple id; a same-commit disposition is published before its `reminder_fired`.**
6. **Frozen exact-batch retry, stop-at-failing-entry semantics**: later entries skipped, no startup due processing, no release of unrelated scheduling; earlier channel/guard commits and receipts survive and replay; if create already published the session, recovery goes through open of the same session.
7. **First-open split** (section 3).
8. **Cron grammar and the zone are harness-owned in the earlier plan.** The report proposes local validation of the "supported five-field numeric grammar" (row 3); plan rev 5 says cron is validated by the harness only. See condition 2.
9. **Guard-exhausted channels are silent** (no routine deadline, no routine occurrence, no `unattended_limit` disposition): not an error, not observable except through absence. Consumers must be told (condition 12), and the library must not treat missing routine notices as a fault.

## 3. The provisional first-open plan (non-activating routine changes in the startup batch; hold create/resume/schedule replacement until the open result proves routines + guard)

**Sound in outline**, and it has two real benefits: offline cancel and pause still beat due work (they ride in the startup batch, applied before due processing), and routine creates, which are the only entries that can hit the 250 ms proof budget, never enter the startup batch, so a pathological cron cannot brick every
open (the failure becomes a live-request `storage_failure` to the caller). It also fits the code: held entries stay `pending` (mutable, coalescable, not `maybe_sent`), `stage()` just needs a predicate, and the existing post-open `dispatch()` already drains remaining pending entries live in staging order, so the "send live after the open" step needs no new mechanism.

What it needs, and what it breaks:
- **a. Per-reminder order with a held activation.** A pause/cancel that follows a *held* create (or replacement) cannot go in the startup batch alone: the harness has no such reminder (`not_found`) or the old calendar would run. Rules: cancel after a never-sent create drops both (already how the journal coalesces); pause after a held create must stay held with it and the pair is sent live as create then pause;
  a pause/cancel after a held *replacement or resume* of an existing routine **can** go in the startup batch only if it carries its intent without the held entry. This is the pin's "resolve a local intent conflict before sending" and must be a written, tested table (create/replace/resume x pause/cancel/text/grace/missedRuns/overlap). Note a create has no `state` field, so "create then pause" has a window between the two live requests in which a due first occurrence can run; for a held create whose first occurrence is already past, prefer holding the create until resumed (treat it as locally paused).
- **b. It breaks "an offline schedule edit beats an overdue occurrence" for routines.** R8 applies one-off edits before due work. With replacement held, the *old* calendar's due occurrences are processed during the open, before the replacement arrives (the pin accepts this: occurrence-first commit order). Make it a conscious ruling, and consider the cheap mitigation: when a replacement is held for a routine, also send a non-activating `pause` in the startup batch and let the post-open path send replacement + resume (needs a clean journal representation, since a synthetic pause consumes a changeId and emits events; fail-safe if the guard never confirms: the routine stays paused).
- **c. Persist the guard evidence.** A new process cannot know the effective guard before the open, so the split applies on every start. The guard is immutable once bound for a session identity, so evidence from an earlier open of the **same session identity** (stored in the wake index JSON next to `supported`, cleared on session replacement) is safe and would remove the hold on all but the first open after a fresh session or a first enable.
  The pin says "until executable open confirms the effective guard"; relying on stored evidence is an optimization that needs haurness-l/Clad1a agreement, not something to adopt silently. Either way the evidence the open returns must be persisted for wake derivation (point e).
- **d. Journal states.** A held entry is `pending`; a consumer sees `pending` indefinitely if the open proves routines unsupported or the guard null. Decide the terminal outcome: send it live so the harness records `blocked / unattended_guard_required` (durable receipt, matches the pin) when the guard is null, and use a local quarantine reason (the existing `invalid_local_entry` mechanism) only when `capabilities.routines` is absent (pre-0032 peer, no way to send).
  Apply the hold to **routine kinds only**; one-off creates, resumes and schedule edits keep the R8 path (the kind comes from the cache/journal schedule). Held entries must not be marked `maybe_sent` or given a frozen wire until they are actually sent.
- **e. Wake.** The pin says held activations alone contribute no host wake deadline. The report instead admits a validation wake for any eligible pending routine create. Reconcile: validation wakes only when guard evidence is confirmed for the session (point c); otherwise none. Consequence to document: a routine created offline on a host that has never opened with a guard does not start the harness by itself; it is sent at the next start and, if the first occurrence has passed, catch-up policy applies from the original anchor.
  Non-activating pending entries (pause, cancel, text) remain wake-neutral exactly as in 0031. Interval routines use `startAt` as `dueAt` (the wake uses `min(acceptedAt + 2 min, dueAt)`, so only the validation part matters), cron `dueAt = null`; the wake filter that currently drops everything but `at` must change in the same commit as the held predicate or held routines will wake the host.
- **f. Frozen exact-batch retry is not what R8's `stage()` does.** R8 re-selects all `pending`/`maybe_sent` entries in staging order on every attempt, so a retry can append entries accepted in between. Freeze the batch composition (the `(reminderId, changeId)` list) at first send, retry exactly that set, and let new entries go live after the open. Define the bound and what happens at exhaustion: keep failing closed (host start error, due work never runs ahead of owed cancels) or quarantine the failing entry; with routine creates held, only generic storage failures can reach this path, so fail-closed with an explicit `retry_exhausted` journal diagnostic is defensible.
- **g. The create-then-fail case loses the "fresh session" signal.** `fresh` is true only when `session/create` succeeded. If create publishes the session and then fails with `storage_failure`, the retry goes through `session/open`, so `replaceSession` (unacked entries back to `pending`, cache flagged `unreconciled`, fence reset) never runs although the harness session is new. Persist a "replacement attempted" marker before sending create (or treat any create attempt as a replacement) and cover it with a test.

## 4. Other soundness points in the report

- **Live `storage_failure` must not look like a failed create.** On the live path the entry stays `maybe_sent`; if the consumer's `create()` simply rejects, they retry and mint a second reminder id. Return a pending/`maybe_sent` view (or an error that carries the reminder id) and retry with backoff under a bound.
- **Dispositions must not be deduped by tuple.** Row 11 keeps "exact duplicate suppression bounded to session identity", but the pin says there is no contractual tuple id and no replay; the two delivery routes are alternatives, not duplicates. Deliver each frame once per connection and do not suppress by content.
- **`invalid_config` is not transient.** It must not consume the restart budget or be retried; surface it as a typed incompatibility on every start until the consumer fixes the config (otherwise `#reopen` retries it three times). Same for a configured guard against a peer without `unattendedTurnGuard`.
- **Do not duplicate the harness's cron grammar.** A local parser that disagrees with the harness (AND of the two day fields, steps only on a wildcard or range, no names or macros, Sunday = 0) either rejects valid input or accepts input the harness blocks. Keep local checks to the shape (non-empty, five fields, allowed characters) and use the harness's error; if a full local parser is wanted, share the harness's test vectors.
- **Event plumbing is a required change, not a note.** `reminderNotification`'s kind allowlist, its required-field checks, the stdio filter regex and the host's `onChannelEvent` route must all learn `routine_disposition` and `routine_migration_blocked`. The R8.5 review found those validation checks have no unit test (they survived mutation on alpha as well); add the table-driven test with the new kinds.
- **`reminder_fired` must stop meaning "terminal".** The R8 cache path marks any fired reminder `completed` with `nextRunAt: null`; the report says to fix it; add the explicit "routine stays active after fire and after a range disposition" test, and keep one-off behaviour.
- **Dependency on the harness merge.** The typed adapter derives from the harness types (R8.5). The routine variants, `routine_*` events, `timezoneMigration`, `remainingCount` and the new capability and limit fields exist only once the 0032 harness code is merged; "keep harness code outside the patch" means Part 2 builds on that merge. State the base.
- **Schema.** No SQLite bump is needed (journal, cache and wake JSON take the new fields; old rows decode); say so after checking one decode of a pre-R9 journal row, and add the guard evidence to the JSON wake index rather than a new column.

## Conditions for Part 2

1. Rebase the table on the pin (items 2.1-2.9) and drop the open questions it answers.
2. Rule on local cron validation (shape only, or a shared-vector parser).
3. Define who rejects a kind change on update (one-off to routine or the reverse, `every` to `cron`) and with which code, before any write.
4. Negotiation before sending `limits.unattendedTurns`; `invalid_config` and a missing capability are non-retryable typed incompatibilities.
5. Freeze the exact batch composition; bounded retry; written exhaustion behaviour; live `storage_failure` returns a retryable pending view.
6. Keep the "no `invalid_params` strip" rule for `storage_failure`, and keep the guard/channel commit survival.
7. First-open staging table (3a), the replacement ruling (3b), evidence persistence (3c), terminal outcomes for held entries (3d), wake predicate in the same commit (3e), the create-then-fail marker (3g).
8. No tuple dedupe for dispositions; ordering tests: disposition before fired, `routine_migration_blocked` before `reminder_changed`, same-target reopen emits nothing.
9. Event plumbing (allowlist, required fields, filter regex, host route) with mutation-proven tests.
10. Routine fire leaves the routine active; all row fields (`remainingCount`, `missedRuns`, `overlap`, `timezoneVersion`, `timezoneMigration`, explicit interval `startAt`) round-trip.
11. Gate as stated (typecheck, plain `bun test` on a clean archive, new tests 20x, 35 snapshots, ceilings with host 909/909); the real-stdio acceptance needs the harness merge.
12. Docs: add the guard-exhausted silence, held activations and the no-wake consequence, no `unattended_limit` event, cron day fields use AND (state it in the tool descriptions too), count/until rules, the migration event and row, and that the library's SQLite schema stays 22 while the harness moves to its lazy format 8.
