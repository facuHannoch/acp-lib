# TODO: intermittent managed checkpoint failure (`internalSessionActivatedAt must not be after updatedAt`)

Status: open, waiting on the owner's triage (A2 open question 6). Found 2026-11-13 during A2; recorded 2026-11-15.
Error record: `$AGENTS_COMMON_ARTIFACTS_DIR/errors/11-15-managed-checkpoint-activation-timestamp.md`. Status issue:
`status/11-15-ISSUE-A2-checkpoint-timestamps.md` (on `controller-interface-status`).

## What

In managed mode (`SessionManager` sessions; agents-core's path), a turn or a handoff sometimes fails with
`CheckpointValidationError: internalSessionActivatedAt must not be after updatedAt`, thrown at
`src/persistence/checkpoint.ts:141` (`timestampNotAfter`). Expected: the checkpoint validates and the operation succeeds.

## Where

- Check: `src/persistence/checkpoint.ts:141`, `:296`.
- Likely source (a hypothesis, not verified): `internalSessionActivatedAt` comes from an observation time read separately
  from the checkpoint's `updatedAt` (`src/agent-session.ts`, around lines 3870–3890), so two clock reads can come out
  in the wrong order.
- Present on A1 (`9de0ca3`) and A2, so it predates A2.

## Evidence

- Characterization comparison, study 6 (A1 vs A2, 50 runs each): A1 run 28, A2 runs 23 and 26 failed. Two of 20
  repetitions of the characterization and watcher tests also failed (runs 2 and 19), in the managed plain prompt.
- All five failures are dated 2026-11-13, 14:51–15:07 UTC, about an hour after a machine restart at 14:12.
- None in the 300+ study runs earlier on 2026-11-13, none in the 17 study runs completed on 2026-11-15, none in four
  full-suite runs. File times are not conclusive wall-clock evidence.
- The clock-drift explanation I gave first was wrong (the dates didn't match) and is withdrawn. The cause is unknown.
- These are failed runs, not green evidence. Study 6 reports them as failed, with a complete-case recount.

## Impact

- It fails a managed turn or handoff; the run continues to the next case. A failed handoff also fails the next turn.
- Not shown: a stuck conversation or channel, or silently lost data.
- Likelihood unknown (5 failures in about 120 runs inside one hour; none outside it).

## How to reproduce

Not reliably. The failing cases were managed `a plain prompt`, `a permission request answered through the handler`,
`a handoff with a summary`, and `two steer messages combined into one run`
(`test/conversation-turns/characterization.test.ts`). Repeating that file many times and watching for the error is the
only method so far.

## Decision needed (owner, via the spec owner)

Under the plan's triage rule, a finding is fixed only if it can leave the agent or a channel stuck, silently loses
data, or contradicts a spec. The evidence shows none of these yet. So either:

1. **Accept** it as a known limitation, recorded in the controller-interface spec's Limitations, or
2. **Investigate** it as a separate defect (find the cause; fix the clock reads so `internalSessionActivatedAt` is never
   after `updatedAt`).

No source fix is authorized in A2. If it is investigated, first find out whether the failure leaves the conversation
unusable afterwards, and whether the failed checkpoint is retried or lost.
