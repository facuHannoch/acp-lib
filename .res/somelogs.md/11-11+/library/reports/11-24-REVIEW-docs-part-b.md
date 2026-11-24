# Review: 0.13 docs Part B, reminders (`docs-0.13-update` at 613e091)

Reviewer: clad2a-s. Clean `git archive` of 613e091 on `/dev/shm`; no edits to the branch; snippets and probes in a scratch copy.

Verdict: **approve with 5 small edits.** Every reminders claim I could test against the code is true, the guide samples compile and run, and the four Part A fixes landed. No claim is wrong; the edits close gaps a consumer would hit.

## Scope and gate

- Delta against the candidate `2fd28d4`: **five docs files only** (`CHANGELOG-controller-interface.md`, `CHANGELOG-operation-lifecycle.md`, `CONSUMER_GUIDE.md`, `MIGRATION-0.12-to-0.13.md`, `README.md`); `src/` and `test/` delta is empty.
- `tsc --noEmit`: exit 0. Plain `bun test`: **2,163 pass / 0 fail, 225 files, 35 snapshots.**

## Samples

- The three guide functions (`promptWithStatus`, `scheduleFollowUp`, `listReminderPages`) compile against `src/index.ts` (project tsconfig). Negative probes were reported (a misspelled `reminder.stat`, and `limit: "50"`), so the check is live.
- I ran the reminder logic of `scheduleFollowUp` and the paging of `listReminderPages` against a real file-backed SQLite Agent through the native test rig, harness never started: `conversationCapabilities.reminders` is `true`; `create({ in: 5 min })` returns `state: "pending"`, `status: "active"`, provisional expiry grace 600,000 ms (2x the 5-minute lead), and **no harness launch** (`rig.launches` stayed empty); four reminders page as 2 + 2 with a cursor and a null last cursor.
- Event kinds from the guide (`reminder_intent_recorded`, `_discarded` observed; the rest type-checked): all eight reminder kinds narrow in both `AgentSessionEvent` and `AgentConversationEvent` with the documented fields.

## Claims verified (probe or code)

| Claim | Result |
|---|---|
| `every` and `cron` are refused with `routines_unavailable`, before any write | confirmed by running both |
| Lead below two minutes; explicit grace below five minutes | `invalid_schedule`; `invalid_input` (guide gives the bounds); `expiresAfter: null` accepted |
| Omitted `expiresAfter` = 2x lead clamped 5 min..24 h; explicit integer within bounds; `null` = no expiry; expiry at the instant without a notice; schedule edit re-resolves a defaulted grace and keeps an explicit one or `null`; pause/resume do not move expiry | match 0031, the R8 tests and the joint tests (expiry boundary test passes on the real harness) |
| ACP conversations reject with `reminders_unsupported`; `get` returns `undefined` for a missing view; update/pause/cancel of a cancelled reminder is `not_found`; update with `policyNames` and an empty update are `invalid_input` | confirmed by running |
| `conversationCapabilities.reminders` is provisionally `true` for native and negotiated on initialize | `nativeConversationCapabilities(reminders = true)` fed by `reminderSync.supported` |
| `agent.reminders.list` returns `{ items, nextCursor }`, default 50, max 100 | `ReminderService.list` |
| Offline writes journaled, no harness start, validation wake may start it early; `reminders_unavailable` without a durable repository; blocked entries stay visible; `discardBlocked`; new id to correct a blocked create | R7/R8 behaviour and tests |
| `authorize(conversationId, op)` with ops `create`/`update`/`cancel`; `limits` as local defaults before negotiation; host `policyNames` only, never copied; updates cannot replace names | service code |
| `AgentConfig.harness.idleStopMs` positive enables, zero/omitted off; `idleStopWindowMs` defaults to 0; per-conversation override "through its runtime settings"; largest window among channels with active confirmed reminders; `reminderTimer` injection | code; I also checked the override: `agent.conversations.create({ runtime: { idleStopWindowMs } })` compiles and reaches the controller (60,000) |
| Idle stop waits for local work, sends `session/stop { ifIdle: true, unlessDueWithinMs }`, refusal `busy`/`next_due_soon` leaves it running | host code and R8/joint tests |
| Cold wake: SQLite file owner only; harness owns scheduling while running; `stop()` drains deadline updates from the stopping connection then re-arms; `close()` disarms and keeps the stored wake; 60 s clamp with wall-clock recheck; same-session revision fence with logged conflicts; crash window | e88dac7 fix, supervisor code, joint tests, R-H3 |
| Schema 22 is one way and older code refuses it; harness format 7 activates on the first durable reminder write and older harness binaries refuse it | `SQLITE_AGENT_SCHEMA_VERSION = 22`; harness `formatVersion === 7` handling and the format 2..6-only check in older code |
| Exports: 924 claimed, nine reminder names | recomputed with the TypeScript API: fb20ed6 = 915, branch = **924**, none removed; added `Reminder, ReminderCreate, ReminderEdit, ReminderError, ReminderErrorCode, ReminderEvent, ReminderSchedule, ReminderScheduleInput, ReminderView` |
| Status line, version wording | covers `alpha` through fb20ed6 plus `pre-alpha-r8` at 2fd28d4; package version still 0.12.1 |

One check I did not repeat: opening a real 0.12.1 schema-16 database at schema 22. I did that for 16 to 21 in the earlier release-docs review; the 21-to-22 step is covered by the real schema-21 upgrade test in the suite (it passes).

## Part A fixes

All four landed: the count now reads 913 at 510e2a7 / 915 at fb20ed6 / 924 on the candidate; the guide's message-event table has a `message_status` row; the 0.12.0 changelog heading has its subject back; the README activity list contains `provider_notice` (but see edit 1).

## Edits

1. **README sentence.** The list now reads "... `session_info`, `config`, and `provider_notice`, `unknown` for anything the protocol adds later". Use "`config`, `provider_notice`, and `unknown` for anything...".
2. **`reminderTimer` is undocumented and its type is not exported.** The guide says it "injects a clock and cancellable timer" but gives no shape, and `ReminderTimer` (`{ now(): number; set(delayMs, task): () => void }`) is not in the 924 exports, so a consumer cannot name it. Document the two members (an injected clock must also drive the 60 s clamp), or export the type; the export count would then be 925.
3. **Error codes.** The guide names three codes (`reminders_unsupported`, `routines_unavailable`, `reminders_unavailable`). A consumer also receives `invalid_schedule` (lead below two minutes), `invalid_input` (explicit grace out of bounds, empty or policy-changing update), `conflict` (terminal or cancelling reminder), `not_found`, `unauthorized`, and harness block reasons on a blocked view. Add a short table (the type `ReminderErrorCode` is exported).
4. **Wording.** "Without durable storage, stopped mutations ... return `reminders_unavailable`" (migration) should say "reject with", as the guide does.
5. **Status line after merge.** "...and the one-off reminders in `pre-alpha-r8` at `2fd28d4`" is branch-specific; when this lands on `alpha`, rewrite it as "through <alpha sha>".

Optional: README has no reminders pointer at all (only the activity list fix); one sentence linking the guide section would help. Direct `AgentSession` use without an owning Agent throws `reminders_unavailable` from the `reminders` getter itself (not a rejection); the guide covers only Agent-owned conversations, which matches its first sentence.
