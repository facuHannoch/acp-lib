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
