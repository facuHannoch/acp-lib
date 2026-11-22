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
- Brief G in from cod2a, `0640c38` ([report](reports/11-22-REPORT-OG.md)); sent to clad2a. Findings: the repository
  signatures are mapped; Gate 3 owns `stage`, discovery, transitions and the native flush (O1–O5a call none of them).
  **But** the repository lacks three things that O2, O3a and O5a need: carrying an assignment's causal binding to a
  successor run after a steer (it can stage the old ACP operation at a steer boundary), durably suppressing the
  notice of an explicit stop (interrupted assignments are staged unconditionally), and a separate redirect notice to
  the previous destination. Also: the staged source is the worker conversation id, not its handle; the result text
  is all completed assistant messages, not "the final message"; ACP and native routing needs a boundary so Gate 3's
  scan never sends an ACP destination to `channel/notify`; per-invocation sender attribution has no source on the
  callback. `agent_action` records exist in the code (the spec's absence claim is wrong; v1 still adds none). O4
  needs one small reviewed exception to the no-edit rule on `agent-session.ts` (a forwarding delegate beside
  `answerPermission`).
- Brief G review in from clad2a, `68bad97` ([review](reports/11-22-REVIEW-OG.md)): accurate; **nothing blocks O1**.
  Needs decisions before O3a: (1) `agent-session.ts` edit for O4: needed (the permission coordinator is a private
  field); the smallest form adds no lines (one constructor line passes `this` as a registry key; a WeakMap and a
  `forwardPermission(conversation, …)` in `permissions/conversation.ts`), its own reviewed commit; (2) steer
  successor correlation (one assignment spans a steer chain, one final notice), explicit-stop notice suppression and
  the redirect notice to the previous destination, none of which the worker delivery repository supports (blocks O3a
  and O5a; ownership to decide); (3) an ACP destination's delivery has no delivered mark, so it stays pending: either
  a best-effort ACP half, or the ACP half calls `stage` and `transitionDelivery` itself (clad2a recommends the
  latter). Also: read-only discovery (unstaged or pending assignments) is a missing Gate 3 deliverable. Spec
  corrections applied: the `agent_action` claim; message capture `content` required for the orchestrator;
  `permission_requested` gains a `source` mark and an optional `turnId` for forwarded requests.
- User decisions: (1) the one-line `agent-session.ts` edit for O4 is allowed (own reviewed commit; the registry key
  change adds no lines); (2) no notice is needed for an explicit stop or a redirect (the entity is one agent): no
  suppression, no `worker_redirected` notice in v1; but **one assignment spans a steer chain** (one final notice);
  (3) the ACP half uses the same store steps as native (stage, deliver, mark delivered), so recovery is uniform.
  Spec updated. Requirements for the worker delivery side sent to haurness-l and Cod1a: carry an assignment's binding
  to a successor run (and no notice for a steered end), read-only discovery, the destination-kind filter and the ACP
  delivery marks, the worker handle as the persisted source label, and the result projection.
- Cod1a can take the worker delivery amendment (decision 0025 and its LOG, the contract, the SQLite implementation,
  the terminal reasons, the scoped `persisted-lifecycle.ts` change, the host scan wiring, tests) once haurness-l
  confirms ownership. Allocated: `src/native/*` and those files are theirs; `src/orchestrator/`, the `workers?`
  repository (schema 19), the worker role, the observation surface and the one-line `agent-session.ts` edit are
  cod2a's. A migration, if any, is schema 20, after O1 merges. They pin: the durable continuation boundary, the
  discovery cursor and state, the destination kind, the immutable worker handle and the final-message projection.
- Cod1a's draft signatures (pending Clad1a and haurness-l; no runtime edits): `reserve` with `destination: { kind:
  'native' | 'acp', id }` and `workerHandle`; `continueAssignment(assignmentId, predecessorMessageId,
  successorMessageId)` → `'continued' | 'existing' | 'conflict'`, committed before the successor dispatches (O3a
  calls it from the successor's `beforeDispatch`); `discoverAssignments({ destinationKind, state: 'unstaged' |
  'pending', after?, limit? })` with a cursor; `latestOutcome(workerConversationId)`; the ACP half marks receipt with
  `transitionDelivery(id, { from: 'pending', to: 'delivered' })`. A migration, if any, is schema 20. Shared with
  cod2a for planning only.
- haurness-l updated the external notices plan (`2b63dc2`: the Gate 3 handoff module, what is built, what remains):
  Cod1a owns the worker repository and lifecycle and a new focused native delivery module (base alpha `3fd2db2` plus
  that commit); the result is the final completed assistant message (missing or empty reviewed in the contract);
  the steer linkage is durable before the successor dispatches. Settled with them: any Cod1a migration is schema 20,
  built after O1's 19 is in alpha; the `src/native/host.ts` hook points are Cod1a's too (their own reviewed commit);
  the only other overlap, `agent-session.ts` (O4's one line) and Cod1a's scoped `persisted-lifecycle.ts`, is by
  grant.
- Cod1a's contract amendment (`cef527a`, docs and types; Clad1a reviewing) inspected: `markSteered`,
  `continueAssignment(assignmentId, predecessorMessageId, successorMessageId)`, `closeContinuation`, typed
  `destination` and immutable `workerHandle`, `discoverAssignments` (oldest first, exclusive cursor), `latestOutcome`,
  the result is the last completed assistant message (a missing or blank one is a known failure, "worker produced no
  saved result"), ACP delivered only on a durable keyed append. It fits O3a. Notes sent: a combined steer (two folded
  messages) must chain `continueAssignment` message by message; name when `closeContinuation` is needed and who calls
  it; the ACP stable-id append is the orchestrator's (O3a, added to the spec). Schema 20 allocated to Cod1a, after
  O1's 19 is in alpha (O1 must merge first).
- O1 in from cod2a, `bf368b6` ([report](reports/11-22-REPORT-O1.md)); review from clad2a, `73a8852`
  ([review](reports/11-22-REVIEW-O1.md)): meets the brief, no blocking findings (real v16 and v18 databases upgrade to 19;
  6 racing opens with limit 2 gave exactly 2). **O1 gate passed** ([gate](../.plan-execution/status/11-22-GATE-O1.md)):
  1,521 in 140 files. Carry-over: zombie row for a directly deleted worker (O5a), a failed reload evicting another
  worker (O2), the direct-open limit bypass (Limitations), restore three comments in `conversation-manager.ts`, a
  changelog line for `AgentEvent`.
- **Correction to my steer proposal.** I had misread the user: they did NOT say every `send` creates a new
  assignment. The model: by default a send continues the running assignment (a steer does not break it; `redirect`
  only moves where its result goes); `send(..., { redirect?, assignment?: "new" })` lets the agent explicitly start
  a new assignment (the running one ends interrupted, steered, notice to its destination). So Cod1a's continuation
  contract (`18df7e1`) stands and the hold on it is lifted; `closeContinuation` also serves `assignment: "new"`.
  Spec updated (Operations, Flow 2, O2, O3a).
- Cod1a's `assignment: "new"` addition (`0c9ce89`, on `25b0126`; Clad1a reviewing): `closeContinuation(old, expected,
  failure, mode?: "replace")` plus `reserve`, in one transaction; the old final wins if first, otherwise the old
  assignment stages an interrupted notice with the public reason "worker interrupted by steering" and
  possiblePartialEffects true; an idle worker only reserves; redirect plus new changes only the new destination.
  Asked: O3a runs both calls in one `persistence.transaction` on the scoped repositories, from the successor's
  `beforeDispatch`: confirm and add a rollback test to the contract.
- Clad1a did not approve `0c9ce89`: the explicit-new close and reserve must be one atomic repository method, not
  two calls. Agreed: `replaceAssignment` returning `replaced`, `old_settled` or `conflict`; O3a calls that one method
  from the successor's `beforeDispatch`. Asked Cod1a to pin the orchestrator's action for each result and the
  idempotent retry. Next owner: Cod1a.
