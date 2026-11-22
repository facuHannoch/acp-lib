# Log: orchestrator (G, O1–O6)

Spec: `11-11-SPEC-orchestrator.md`, section "Implementation plan". Rules: `../.plan-execution/plan.md`. Written only
by the coordinator; reports and reviews are linked, not copied.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `orchestrator-status` |
| Implementer | cod2a | `orchestrator` |
| Independent reviewer | clad2a | `orchestrator-reviews` |

All three branches start from alpha at `4e88243` (integration R1–R3 merged, on worker delivery `d403bf4`).
Baseline: `bun test ./test`, 1,509 tests in 137 files, green. The user merges into alpha.

Standing constraints: O1 builds on the worker delivery repository (`src/persistence/worker-delivery-contract.ts`,
schema 18: assignment correlation, final and failure outcomes, staged notices) and adds no second assignments
store. Left open by worker delivery, owned here: the host flush through `channel/notify`, retries after a lost
acknowledgement or a resume, and a live provider run (needs the user's authorization; O6 step 3). The spec says no
edit to `src/agent-session.ts`.

## Entries

### 2026-11-22: setup and brief G

- Branches created at `4e88243`.
- Brief G (grounding) assigned to cod2a.
- clad2a's read-ahead for G: the spec stores assignments and results in a new `workers?` repository, duplicating
  worker delivery's `worker_assignments`; `workers?` should hold only the worker rows; it would be schema 19, not 18;
  delivery reads only the assignment's destination (`last_conversation` at most the default for the next one); the
  orchestrator requires `capabilities.workerDelivery` as well.
- **On hold** at the user's request, before G's report. cod2a paused with a clean worktree at `4e88243`, no G edits;
  baseline green (1,509 in 137 files, 110 s).
- Spec review 2 (`3fd2db2`, on alpha) checked by the coordinator. Fixes applied (user-approved): the integration
  spec's R3 note (0022 is in alpha; R3 is built, gated and merged); schema numbering (`workers?` is 19, from 18) with
  the chain test; the leftover "system prompt section"; `capabilities.workerDelivery` required as well; Gate 3's
  built part (the `workerDelivery?` repository and lifecycle in alpha) and remaining part (host flush, retries,
  recovery at open); Flow 4 and O4 now say an unanswerable ask is refused (not the default), and that O4 adds a
  forwarding entry to the conversation's permission handling (R3 emits only for a conversation's own turns).
- User approved a revised plan (in the spec, `972bfd1` and after): G, O1, O2, **O4**, O3a, O5a, O3b, O5b, O6. O3 and
  O5 split: O3a (assignments reserved before dispatch through `beforeDispatch`, the ACP half, the items) and O5a
  (stop, drop, idle stop) need no Gate 3 remainder; O3b (native delivery) and O5b (restart) wait for Gate 3's host
  side (the flush, retries, recovery at open), built by the harness work in parallel. G also writes the interface
  with that remainder and sizes O4's forwarding entry (the only change to R3's code).
- G resumed on cod2a (from `4e88243`; the spec is read from `orchestrator-status`).
- Gap in the coordinator's first fixes, found by clad2a: the spec still sent results to `workers.last_conversation`.
  Fixed: delivery reads only the assignment's destination (which `redirect` retargets); `last_conversation` is the
  default destination of the next assignment (the workers table, the Flow 3 table, O2 and O3a).
