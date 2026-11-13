# A2 review preparation: managed snapshot decision

Assignment: `controller-interface-status:.res/somelogs.md/11-11+/.plan-execution/tasks/controller-interface-A2-managed-decision.md`.
User and spec-owner decision: beta `95e9cf249dbef18ee2a3d59322010a7447158058`.

Merged that exact beta into `controller-interface-reviews` in merge commit
`c00f8b7590085afaa002eebcba8fc64788a88edb`, first parent
`1ecc023ea27f5500d3ea2103fc1aeaa49c3de6d2` and second parent the requested beta.
The merge was clean, preserving all prior reviews. Both parents are ancestors; the
merged controller-interface spec matches beta and the merge changed no source or
tests. Worktree was clean before the update. I read the entire updated spec, both
appendices, the complete updated metering-order finding, and the assigned task.

## Final review criteria

The single dedicated test/snapshot exception commit may accept a turn's managed
metering event anywhere among **that same turn's** presentation events, only after
`turn_started` and before `turn_completed`. Presentation events retain their own order,
including in-progress before completed. Stable IDs, exactly one metering event, and
completion after metering and the last presentation remain strict. Agent-owned scope
remains metering versus the last in-progress assistant snapshot record only. No other
reordering, cross-turn mixing, content/ID loss, weakened assertion or masked sequence
violation is authorized. The prior snapshot-only `cause` addition remains separately
authorized.

I will review the dedicated diff and how actual record sequence numbers are verified;
check all explicit contractual assertions, including provider result before metering,
final message before completion, and completion after metering, transcript and
`afterPrompt`; and verify bounded event barriers where a specific sequence is required.
The existing ACP stuck-connect exception remains narrowly accepted, with prompt
rejection and non-overlapping reconnects still required.

The approximately 50-run A1/A2 comparison must report all **three** managed positions
separately, including zero counts: `M → P1 → P2`, `P1 → M → P2`, and
`P1 → P2 → M`, with per-turn counts where applicable. Agent-owned before/after counts,
unclassified failures, comparable instrumentation, noise controls and limitations are
also required. A noticeable shift in any of the three positions warrants investigation;
finite samples do not establish equal rates. The user explicitly requested these counts,
so binary aggregation is insufficient.

## Spec wording to reconcile

The updated spec's Acceptance bullet at `library/11-11-SPEC-controller-interface.md:639`
still says the A1 snapshots change only for `cause`. Its later Risks clause at `:652`
and the explicit current assignment authorize the separate narrow exception. The
current direct task and user decision clearly authorize that exception for this review;
the stale Acceptance sentence should be corrected by the spec owner so future readers
are not left with contradictory instructions. This wording issue does not block the
beta update or require weakening any assertion.

## Verification and limits

`git merge-base --is-ancestor` confirmed the pinned beta and previous review-preparation
commit. No suite was run for this documentation-only update. Other tracked beta
updates include the integration plan, protocol and harness documentation; no merge
conflict or unexpected source change occurred. No implementation checkout, reviewer
source edit, live harness, push, merge into beta, or protected path/worktree/process
change occurred. Await the coordinator's final A2 review assignment; B1 remains held.
