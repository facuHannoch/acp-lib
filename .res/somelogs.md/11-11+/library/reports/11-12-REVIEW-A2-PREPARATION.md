# A2 review preparation and beta update

Reviewer: agentco-1. Assignment: `controller-interface-status` at `fba96a6`,
`.plan-execution/tasks/controller-interface-A2.md`; plan: `.plan-execution/plan.md`
at the same commit.

The review branch `controller-interface-reviews` merged the requested beta
`1bda9ef29547446b9012834c1e6e67681769915a` in merge commit
`5e427fca76da8d0f88b3e0f363e5d8a57c6a0681`. Its first parent is the previous A1 review
commit `547b522032ddb44a16f6f7bd5256385b7d7da6e8`; its second parent is the requested
beta commit. Both are verified ancestors. The merge was clean, and the worktree was
clean before and after it. Prior A1 reviews are preserved. No changes to `src/` or
`test/` were introduced by the merge; beta changes are documentation, including the
plan, controller-interface and integration specs, and harness protocol draft.

I read the complete 726-line controller-interface spec at the pinned beta commit,
including the A2 brief and both appendices, and the complete execution plan. The
review will use the updated `send(): Promise<void>` acceptance boundary, optional
`TurnRun.turnId`, `turn_took`, synchronous harness turn reporting, and the separation
of backend-scheduled send acceptance from the later queued turn and prompt settlement.
The A1 snapshot exception remains limited to adding `cause` in a snapshot-only commit;
visible `AgentController` error text remains unchanged. All review work remains on
this branch; the implementation branch will be inspected without checkout.

## Spec wording conflict to escalate

The updated spec defines `TurnEvent = TurnStarted | TurnTook` at
`library/11-11-SPEC-controller-interface.md:201` and says at `:222` that a
backend-scheduled controller reports `turn_took`. Yet `:232` still says
`turn_started` is the only turn event the controller reports. The surrounding
sentence correctly assigns completion and failure to the session; the exclusivity
wording conflicts with the new contract. Please refer this wording to the spec owner
rather than silently interpreting it away. This does not prevent the requested branch
update or preparation; no A2 implementation has been reviewed.

## Verification and limitations

- `git merge-base --is-ancestor` verified both the exact beta commit and `547b522`
  are contained in the merge; the merged controller spec matches pinned beta byte for
  byte. `git diff 547b522..HEAD --stat -- src test` was empty.
- No test suite was run for this documentation-only merge; the A1 follow-up review
  records the earlier full green run at implementation `9de0ca3`.
- The merge brought changes to other tracked documentation from beta, including the
  integration and harness specs; no merge conflict or unexpected source change occurred.
- No source editing, live harness session, push, merge into beta, or protected path,
  worktree or process change was performed. Await the coordinator's A2 review
  assignment; beta inclusion alone does not authorize an implementation review.
