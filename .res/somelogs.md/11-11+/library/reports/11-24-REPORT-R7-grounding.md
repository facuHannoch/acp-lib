# R7 grounding — reminder store and library model

Part 1 only. Code baseline `f0eb7d8` on `reminders-r7`. Reviewed
the R7 brief, plan revision 5 with all addenda at `a7d7a2c`, and the reminder
spec. The addenda and brief set the common two-minute one-shot lead,
ten-minute repeating interval, and default grace between five minutes and
24 hours. R7 uses those fallback values in one limits object. The outdated
five- and fifteen-minute repeat minimums do not apply. The cap is 20 active
routines per channel. The brief's two implementation steps remain pending
approval.

## Existing lifecycle and proposed ownership

- `NativeHarnessHost.ensureStarted()` returns immediately when running and
  otherwise shares `#starting`. Explicit `restart()` resets the failed state
  and budget. `#start` runs a bounded open and publishes running only after
  startup reconciliation and the channel change fence. `#open` initializes
  capabilities, collects `startupBatch()`, calls `openOrCreate` and
  acknowledges the channel changes. The helper uses `session/open` for an
  existing session and `session/create` on confirmed absence. The plan's old
  `session/load` wording does not describe this code.
- `host.stop()` marks explicit stop, waits for any start in flight, publishes
  stopped, rejects outstanding waits, closes approvals and kills the
  connection after the stop request. An unexpected loss goes through
  `#lost`; outstanding work can trigger `#reopen`. Its default budget is
  three attempts in 60 seconds and exhaustion is surfaced. `Agent.close()`
  calls `manager.stopAll()` before stopping the shared host and closing
  persistence. R7 needs only read access to host state through a service
  binding; later lifecycle integration belongs to R8.
- Keep the persisted index in the Agent's reminders repository and the
  reminder service, clock input, and future wake scheduler under
  `src/native/reminders/`. In R8 a small host/Agent binding can notify the
  scheduler after committed changes and hand it `ensureStarted()`. Reuse the
  SQLite owner distinction represented by the existing owner lock. Only a
  SQLite owner can arm a wake. Explicit harness stop will keep it armed;
  Agent close will disarm it while preserving the stored index. The scheduler
  will share manual startup and obey the existing retry budget. R7 adds no
  timer, wire call or stop behavior.

## Repository proposal for Step 1

Add an optional `ReminderPersistence` and capability to the backend and
transaction scope, beside `ChannelPersistence` in
`src/persistence/channels.ts`. Use a separate `reminders.ts` contract and
SQLite implementation. `ChannelPersistence` shows the versioned intent
and compare-before-clear pattern; reminder changes also need an immutable
possibly-sent history. Register the new repository in SQLite's shared
`createScope` so root and transaction clients use their correct runners.
Use the scope repositories inside `PersistenceBackend.transaction`.
SQLite queues root writes, runs callbacks inside `BEGIN IMMEDIATE` and
notifies record listeners after commit. Nested calls through the root
repository would wait on that same queue.

- **Change journal.** Key entries by reminder ID and monotonically increasing
  `changeId`, with a stable conversation owner. Store op, normalized payload,
  state and reason. Keep the allocator high-water mark even when confirmed
  entries are cleared, so a replay cannot reuse an ID. Provide operations to
  enqueue/coalesce, mark a selected change `maybe_sent`, reconcile a receipt
  by exact ID, inspect outstanding changes and explicitly discard a blocked
  entry. Once `maybe_sent`, op and payload remain immutable. An edit after a
  possibly-sent create is a separate update. Cancel removes a never-sent
  create and its edits; cancel of an existing or possibly-created reminder
  survives as its own intent while superseding never-sent updates. Test the
  absent versus possibly-present distinction. An older receipt cannot clear
  newer work. Blocked entries remain visible and stop automatic resend until
  corrected or discarded. Local expiry never removes an unresolved entry.
- **Confirmed cache.** Key by conversation and reminder ID with a stable
  Agent-wide order for pages. Store the last reconciled schedule, text,
  provenance, state, next/last run and revision. Expose cache plus current
  pending and blocked overlays; retain enough prior confirmed state to
  reveal it again after discarding an overlay. Keep terminal `expired` in the
  model; a fire event is unnecessary to learn it. Keep a durable confirmation
  and an optimistic overlay distinct so paging does not claim the harness
  has already applied an edit.
- **Wake index.** One row per Agent with the last reported `nextDueAt` and
  revision and a derived effective wake. Update the reported pair with a
  revision fence; a duplicate revision and value is idempotent and an older
  revision cannot replace either field. Effective wake is the earliest
  applicable reported time or locally eligible pending create/edit deadline.
  Exclude cancels, paused reminders, and suspended or retiring targets.
  Update the journal and index in the same transaction. Expose the raw
  reported pair as well as the derived index so an older event cannot
  erase local work. Current channel intents disappear on confirmation;
  confirm how the live channel/session suspension state will feed durable
  wake eligibility in R8. An absent pending channel intent does not itself
  prove a channel is eligible.
- **Storage and delete.** Bump SQLite schema 21 to 22 and test reopening an
  existing 21 database with its prior data. Add the reminder journal, cache
  and wake index in the migration transaction. Extend
  `deleteConversationWithChannel` to delete the reminder rows and recompute
  wake inside the conversation-delete transaction, including when a custom
  backend exposes reminders without channels. Memory can supply the same
  repository behavior for live state and tests; without a durable repository
  an offline mutation is refused. Do not let the presence of a memory
  fallback bypass that check.
- **Reconciliation scope.** The revised open supplies intent outcomes and
  `nextDueAt` with its revision. The confirmed view comes from the bounded
  revision-bound reminder list sweep after open, rather than an inline
  reminder snapshot. This sweep does not feed the wake index. Cursor
  invalidation, retention and exact wire reasons belong to Gate 1 and R8.

## Model proposal for Step 2

Put schedule normalization and policy checks in a library service, with
`Reminder`, `conversation.reminders` and paged `agent.reminders.list()`.
Offer create/get/list/update/pause/resume/cancel/discardBlocked. Native
conversations expose `conversationCapabilities.reminders`; ACP reports
false and rejects with a typed unsupported error. Introduce a small live
request port, faked in R7. Offline writes use the repository and do not start
a harness. A live path reports confirmation only when its result is known.
A stopped list uses cache plus pending changes and exposes blocked state.
Publish the created, changed, confirmed, blocked and cancelled events
through the existing `AgentSessionEvent` and conversation subscription
after relevant writes commit. Fire events and notice-ID deduplication belong
to the later wire step.

Capture acceptance time once. Use an injectable clock for validation without
a timer. Convert relative one-shot `in` to absolute `at` before validation
and journaling. Require at least two minutes' lead, including the exact
boundary. For `every` require at least ten minutes and materialize an
implicit `startAt` once at acceptance. Confirm the exact default first
instant with Gate 1. Keep `cron` and timezone as schedule data; interval
validation and next-occurrence calculation belong to the harness. Keep
validation limits, the per-channel cap, and the default grace range in one
configuration object so R8 can supply `initialize` values. Test counting
against confirmed and locally reserved active routines in one transaction.

For one-shot acceptance, resolve and freeze expiry in the change alongside
the absolute schedule. Omitted `expiresAfter` means add twice the lead to the
scheduled instant, with the grace clamped to 5 minutes through 24 hours. An
explicit duration starts at the scheduled instant and uses that duration.
Explicit null remains null and allows late delivery. Resending preserves
that stored value and the change identity. For a fixed interval routine,
derive the default grace from twice the interval with the same clamps and
persist the first absolute expiry with its fixed schedule and grace; later
occurrences need their own window. A pause or resume is an `update` with
desired state paused or active. Keep wire property spelling in a single
adapter to avoid spreading Gate 1 field names through the model and store.

Two acceptance details need approval before implementation. The local code
has no calendar evaluator, so it cannot derive the first absolute cron expiry
or an accurate provisional wake for an offline cron expression from the
expression alone. Gate 1 should pin the first instant and per-occurrence
expiry representation, and decide whether offline cron needs an explicit
anchor or whether it waits for harness validation. The update contract
should also say which schedule or expiry edits re-anchor the window; a
text-only edit, pause, resume or retry should not drift it. Do not implement
a parallel cron scheduler or silently move a due date to satisfy validation.

Check narrower consumer authorization before any write or live dispatch.
Payloads are host-attributed and contain only additional names explicitly
supplied by the consumer. Do not copy the channel policy from the older
spec. Preserve an unknown name for the harness to refuse as
`invalid_policy` in R8. Treat the authoritative channel or session state and
the negotiated routine guard as separate from persistence availability.

Use a reminder error type with stable codes. Reserve
`reminders_unavailable` for a stopped harness without a durable repository.
Distinguish unsupported ACP use, invalid schedules, invalid input,
unauthorized mutations, limits and unknown reminder IDs. Keep harness
blocks visible by reason instead of collapsing them into absence.
The draft reasons are `invalid_policy`, `channel_missing`,
`channel_retired`, `invalid_schedule`, `limit_exceeded`, `conflict` and
`not_found` for an unknown update. Gate 1 pins stale-version refusal and
the exact wire mapping. A changed payload for a recorded ID is a conflict,
not a valid retry. Existing `HarnessUnavailableError` still describes
harness lifecycle failures.

## File ceilings and acceptance

| Protected file | Baseline lines | Expected R7 use |
| --- | ---: | --- |
| `src/agent-session.ts` | 4,491 | Thin conversation accessor and event bridge if needed. Extract first. |
| `src/native/host.ts` | 909 | Existing state read. Prefer a separate seam with no edit here. |
| `src/controller.ts` | 764 | No expected edit. Set the ACP capability in the shared capability builder. |
| `src/client.ts` | 1,046 | No expected edit. |
| `src/agent/conversation-manager.ts` | 1,012 | Prefer existing native binding and extracted delete helper. |
| `src/agent.ts` | 563 | Thin service assembly if needed. Extract first. |
| `src/metering/engine.ts` | 1,034 | No expected edit. |
| `src/native/controller.ts` | 599 | Native capability binding if needed, with extraction before growth. |

Step 1 gates cover journal coalescing and freezing, delayed acknowledgements,
versioned replay, blocked visibility, wake recomputation and stale revisions,
transactional delete, and 21-to-22 migration. Step 2 gates cover exact schedule
boundaries, the lower and upper grace clamps, payload immutability, permission
checks, cache overlays and fake-live receipts. Verify new cases about 20
times in isolation, typecheck and run the full suite from a clean RAM-backed
archive. Track characterization snapshot hashes and before/after source
sizes. No harness wire, timer, stop, or idle code enters R7.

The clean RAM-backed baseline archive of `f0eb7d8` passed typecheck and
**1,679 tests in 162 files in 119.73 s**. All 35 snapshots passed. The
characterization snapshot hash matched before and after the run. Logs are
in `/tmp/acp-r7-grounding.xxGoer`.
