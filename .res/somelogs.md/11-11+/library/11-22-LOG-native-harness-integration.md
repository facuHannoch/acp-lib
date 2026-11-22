# Log: native harness integration, remaining work (R1–R6)

Spec: `11-11-SPEC-native-harness-integration.md`, section "Remaining work: implementation plan". Briefs R1, R2, R3
in order (R3 depends on R2; the orchestrator waits on all three); R4–R6 later. Rules: `../.plan-execution/plan.md`.
Written only by the coordinator; reports and reviews are linked, not copied.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `native-integration-r-status` |
| Implementer | cod2a | `native-integration-r` |
| Independent reviewer | clad2a | `native-integration-r-reviews` |

All three branches start from alpha at `44bbc25` (spec 1 verification merged on alpha `ac52dbc`). Baseline:
`bun test ./test`, 1,426 tests in 132 files, green. The user merges into alpha.

## Entries

### 2026-11-22: setup and R1

- Branches created at `44bbc25`.
- `src/native/host.ts` is 984 lines at the base (761 when R1 was written; grew with the harness's operator
  controls): R1 must not grow it (extract the records adapter).
- R1 (durable channel intents) assigned to cod2a.
- R1 step 0 in from cod2a, `1bac66c` ([report](reports/11-22-REPORT-R1-grounding.md)): baseline green (1,426 in 132
  files, 243 s). Recommends making the channel half asynchronous, with no mirror: a separate adapter module, delivery
  code extracted out of `host.ts` and the delete transaction helper out of `conversation-manager.ts` first, delivery
  scheduled only after the delete transaction commits. Two ordering constraints to test (edit order registered
  before any await; the startup cutoff scan kept atomic). Open points: the public sync `NativeHostRecords` API, file-store
  pending changes under a durable backend, `harness.records` vs the repository, operator suspend/resume. Sent to
  clad2a for review.
- R1 grounding review in from clad2a, `980f26b` ([review](reports/11-22-REVIEW-R1-grounding.md)): accurate; agrees
  with the async design. A committed read is required (one SQLite connection: a read outside the write queue sees an
  uncommitted delete). Additions: a committed delete reuses `#flushChange` and mints no version; the creation intent
  (`conversation-manager.ts:887`) goes in the create transaction or is documented; `changeChannel` rejections are
  propagated; an allocator test across a reopen. Public API: additive (keep the sync records for the fallback, an
  internal async store). For the user: file-store pending changes under a durable backend; suspend/resume while
  the harness is stopped (and never downgrading a pending retirement).
- Step 1 (the `channels?` repository, schema 17) released to cod2a.
- User decisions: (b) file-store pending changes under a durable backend are ignored, with a one-time warning (spec
  Limitations: only changes not yet delivered at upgrade time are lost); (d) operator suspend/resume while the
  harness is stopped keep failing, with a distinguishable error (e.g. `harness_not_running`), and stay out of the
  durable intent path (so they can never override a pending retirement). Suggested to the user as a separate
  follow-up: schedule `agent.nativeHarness` `state` (listed, unscheduled), so consumers can know the harness is
  offline. Passed to cod2a.
- R1 step 1 in from cod2a: implementation `61ecd21`, report `e55afcf` ([report](reports/11-22-REPORT-R1.md)). New
  `channels?` repository (`src/persistence/channels.ts`, `sqlite-channels.ts`), schema 17 with the upgrade from 16;
  tests for merge, stale acknowledgement, rollback visibility, the v16 upgrade and the version allocator across a
  reopen. Full `./test` green, 1,430 in 132 files, 265 s. Offline suspend/resume throws the shared
  `HarnessUnavailableError` today. Sent to clad2a for review.
- Step 1 review in from clad2a, `3f2a111` ([review](reports/11-22-REVIEW-R1-step1.md)): no blocking findings; their
  own v16 probe upgrades without loss. `HarnessUnavailableError` covers six offline cases with no code, so it isn't
  distinguishable enough for decision (d): add a readonly `code` per throw (keeping `instanceof`).
- **Step 1 gate passed** ([gate](../.plan-execution/status/11-22-GATE-R1-step1.md)): 1,430 in 132 files.
- Step 2 (host records over the repository) released to cod2a, with the error code.
- The user gave durable worker delivery to haurness-l's conversation (Cod1a implements, Clad1a reviews): first a
  narrow proof of recovery by assignment id after acp-client exits before staging. Sent Cod1a our file map and the
  constraints: keep off `host.ts`, `records.ts`, `conversation-manager.ts` and the schema until R1 lands; schema 18 if
  they need a table; submissions aren't durable across an acp-client restart today. Waiting for their file list.
- Cod1a: no shared runtime or schema edits; only the external-notices `LOG.md` (gap and proof plan). Backend
  selection escalated to haurness-l and the spec owner. Correction: the orchestrator spec's Roles says "No native
  workers in v1", so my earlier native-worker suggestion contradicted the spec. Candidate raised instead: recover a
  finalized ACP worker completion from the worker conversation's own records in the Agent database, keyed by an
  assignment → worker turn id persisted before the work starts (O1); a death before finalization is
  `worker_interrupted`.
- R1 step 2 in from cod2a: implementation `56c1b3a`, report `a902ccf`. Delivery extracted to
  `src/native/channel-changes.ts`; `host.ts` 984 → 887; error codes in `src/native/errors.ts`; both decisions and the
  ordering barriers tested. cod2a: three disk-backed full runs had different timeouts, a RAM-backed run green
  (1,442). Coordinator run on disk: green, 1,442 in 132 files, 286 s. Sent to clad2a, with whether step 2 slowed
  anything.
- Worker delivery (haurness-l, Cod1a, Clad1a): contract approved at `89f873d` (docs only). Base, schema and file
  ownership decided by the coordinator (next entry).
- Decision, sent to Cod1a and haurness-l: base on `a902ccf` (R1 step 2, which already has schema 17); schema 18 for
  worker delivery; Cod1a owns its new persistence files and may make additive edits to the shared persistence files
  (R1 doesn't touch them again); `src/native/*`, `conversation-manager.ts`, `agent-session.ts`, `client.ts` and
  `src/permissions/` stay R1–R3's. Worker delivery merges into alpha after R1; orchestrator O1 builds on that
  repository instead of a second assignments store.
- Cod1a asked for a per-prompt `beforeDispatch?: (operationId) => Promise<void>` hook (for the worker binding
  write before dispatch). Kept one writer: cod2a adds it on `native-integration-r` before step 3, in its own commit.
  Awaited after the durable `beforePrompt`, before dispatch; a rejection fails the prompt before dispatch through the
  existing path; combined steer runs await each message's hook in order; native awaits it before any push.
- Granted Cod1a `src/agent/persisted-lifecycle.ts` for one change: `workerDelivery?.recordFinal(...)` in the
  `afterPrompt` transaction after `persistObservationsInTransaction`, on completed status (it depends on their
  repository interface). Conditions: transaction-scoped persistence only; a no-op without the repository or for an
  unbound op; no other edits. R1–R3 stay off that file meanwhile.
- `beforeDispatch` in from cod2a, `acc6d5d`: ACP awaits it after the durable preparation and before
  `prepareTurn`; a rejection runs `abandonTurn` and `turn_failed`; native awaits it before any push. Full `./test` green
  (1,446, on RAM); `agent-session.ts` 4,600. Queued for clad2a after the step 2 review. Question raised: ACP passes the
  operation id, native each input's message id; is it the same identifier Cod1a keys on?
- Step 2 review in from clad2a, `e003573` ([review](reports/11-22-REVIEW-R1-step2.md)): no blocking findings; both
  barriers really raced in the tests; the timeouts are the machine (timings unchanged against `e55afcf`).
- **Step 2 gate passed** ([gate](../.plan-execution/status/11-22-GATE-R1-step2.md)).
- Step 3 (the delete and its intent in one transaction) released to cod2a, on top of `acc6d5d`.
- `beforeDispatch` review in from clad2a, `0fd1e2e` ([review](reports/11-22-REVIEW-beforeDispatch.md)): **blocking**
  for Cod1a's keying. Native: the hook gets the message id, but `afterPrompt`'s `operationId` is `native-turn-N`. ACP
  combined runs pass the first message's id to every hook. Fix assigned to cod2a ahead of step 3: the hook receives
  its own message id on both paths, and `OwnedPromptCompleted` and `promptFailed` gain `messageIds`. Cod1a told to key
  by message id (a contract amendment for Clad1a); haurness-l informed.
- Worker contract (haurness-l): folded operations carry the union of the assignments' policies plus redirect
  restrictions, frozen at staging; a live terminal outcome is `failed` (distinct from abandoned), user cancellation
  included, with no failure-kind field. Cod1a's `persisted-lifecycle.ts` grant extended to `recordFailure` in the
  `promptFailed` transaction and in non-completed terminal `afterPrompt` statuses; same conditions; never both final
  and failure for one binding.
- Hook fix in from cod2a, `7be9456`: own message id per hook; causal `messageIds` on every terminal result and
  `promptFailed`. Review from clad2a, `40bab3f`: blocking finding resolved; probes show the hook id in the terminal
  `messageIds` in every case. **Gate passed** ([gate](../.plan-execution/status/11-22-GATE-beforeDispatch.md)): 1,448
  in 132 files. Sent to Cod1a and haurness-l.
- Step 3 (cod2a, in progress): a gap that predates R1. A never-prompted native conversation has no persisted provider
  descriptor, so after a full Agent restart (another conversation opened the harness and consumed its initial
  intent) a delete can't tell it is native and doesn't retire its channel. Persisting the descriptor at create
  would change first-attachment behaviour: not folded in. cod2a to establish the consequence (an idle leftover, or
  can it take work or block?); if idle, an error note and a Limitations line; otherwise escalate.
- The gap is not idle: in a scripted fixture, the deleted, never-prompted conversation's channel reopened as open,
  accepted `host.push` and committed a reply. Escalated to the user. Proposed: keep channel rows in `channels?` after
  confirm (marked applied), so a delete can identify a native conversation; alternatives: persist the descriptor at
  create (changes first attachment), or accept (not recommended).
- R1 step 3 in from cod2a: implementation `c600199`, report `49b5a1c`. Scoped create/delete rollback, a single version
  delivered after commit, pending retirement precedence; full `./test` green (1,451 in 132 files); `host.ts` 887 →
  884, `conversation-manager.ts` 1,098 → 1,092. Sent to clad2a, with their view on the gap fix.
- Step 3 review in from clad2a, `9e53d13` ([review](reports/11-22-REVIEW-R1-step3.md)): the transaction work is
  correct (the rollback tests really fail the write). Should fix: an operator `resumeChannel` ignores a pending
  retirement, so a busy delete's channel can be resumed and run pending input on a deleted conversation; assigned
  to cod2a (reject with `channel_retired`). The gap is wider: (i) a delete after a restart, before the harness ever
  opened, leaves the creation intent pending, and the next open creates the channel; (ii) a native conversation with
  no title and no policy never gets a row. Fix endorsed, with additions: always register a row at create; on
  confirm keep the row (desire cleared, marked applied); delete checks `known(id)` in its transaction; retired rows
  stay as tombstones. Waiting on the user.
- Resume guard in from cod2a, `64060fa`; review from clad2a, `eec1f82`: resolved (the extended test fails on
  `49b5a1c`; race-free through the per-channel queue). **Step 3 gate passed**
  ([gate](../.plan-execution/status/11-22-GATE-R1-step3.md)): 1,451 in 132 files.
- Worker delivery: Cod1a's implementation `b53abf2` (hook merged at `56ac47a`) is with Clad1a for review; repository
  level only, the host flush and wire integration go to the orchestrator.
- Worker delivery repository and lifecycle **approved** by Clad1a at `b53abf2` (root 1,457, harness 360). Our hook
  commits `acc6d5d` and `7be9456` merged unchanged; `recordFinal` and `recordFailure` run inside the terminal
  transaction as granted. Left to the orchestrator: the host flush through `channel/notify`, retries after a lost
  acknowledgement or a resume, and a live provider run. Merge order: R1 into alpha before `b53abf2` (it contains R1
  up to `7be9456`).
- User decision on the orphan-channel gap: persist the conversation's controller kind. New step 3b, assigned to
  cod2a: `conversations.controller_kind` ('acp' | 'native', null for rows from before), in schema 17 amended in
  place, set in the creation transaction; delete decides native from it inside its transaction (covering the three
  cases); a handoff or switch that would change the kind is refused with `UnsupportedError` before any write
  (switches between ACP adapters unchanged; native has none). A Limitations line for rows from before. cod2a may edit
  `sqlite-schema.ts` and the conversations repository for this; Cod1a told (re-runs migrations on R1's final
  revision).
- Step 3b in from cod2a: implementation `f0e589a`, report `e701ba0`. All three restart cases over SQLite, the v16
  upgrade with fallback to the old detection, both refusals writing nothing; Limitations for rows from before and
  for custom backends that omit the kind. Full `./test` green, 1,456 in 132 files; `agent-session.ts` 4,600 →
  4,567, `conversation-manager.ts` 1,092 → 1,089. Sent to clad2a.
- Step 3b review in from clad2a, `8ad9b97` ([review](reports/11-22-REVIEW-R1-step3b.md)): design sound (5 new tests
  fail on `64060fa`; the kind matches the factory's binding; the refusal is the first statement of `runHandoff` and
  covers handoff, switch and recovery). Should fix: a version-17 database created before the amendment (no column)
  fails on create, because the ALTER only runs below 17; assigned to cod2a (check the column on every open, plus a
  test).
- Column repair in from cod2a, `8b17fbd`; review from clad2a, `1e2988c`: resolved (their reproduction fixed;
  idempotent; fresh and 16 → 17 databases fine). **Step 3b gate passed**
  ([gate](../.plan-execution/status/11-22-GATE-R1-step3b.md)): 1,457 in 132 files.
- Step 4 (restart tests over a real stdio harness) released to cod2a.
- Step 4 case (b): the harness's startup handling creates and retires a channel in the same open batch, before
  admission, so a conversation deleted before the harness first opened shows as a retired tombstone, not absent.
  Decided by the coordinator: the tombstone satisfies (b) (nothing can run, a retired id can't be reopened); assert
  no open channel, the tombstone, a refused push and no turn; a report line; no protocol change.
- Step 4 in from cod2a: tests `be36dfc`, report `79d449d` (Done section complete). Six scripted stdio restart tests
  (4.2 s); full `./test` green, 1,463 in 132 files. Sent to clad2a with the final whole-R1 review.
- Final R1 review in from clad2a, `fd0485c` ([review](reports/11-22-REVIEW-R1-final.md)): code complete and correct,
  no blocking findings; step 4 uses a real stdio harness and a real restart, and 4 of its 6 tests fail on `64060fa`.
  Missing changelog entries (the channels repository, `host.records` under a durable backend, the error codes and
  the resume refusal) and two Limitations lines (tombstones; the memory fallback): a docs-only commit assigned to
  cod2a. For the spec owner: R1's "code as it is" and its steps (3b, the creation transaction, retirement precedence,
  the resume guard), and in "Durable channel intents": `controller_kind`, the kind-switch refusal, schema 17 with the
  repair, the tombstone.
