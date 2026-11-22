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
