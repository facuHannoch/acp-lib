# A2 review preparation: owner decisions on beta

Assignment: `controller-interface-status:.res/somelogs.md/11-11+/.plan-execution/tasks/controller-interface-A2-owner-decisions.md`.
The user-confirmed decisions are on beta `fd9ec24fcf82178912f824529639e3aa6ddde216`.

Merged that exact beta into `controller-interface-reviews` in merge commit
`a7afc4474aae67d1c1c1420ff8d553f3a298717e`. Its first parent is previous review
`a661a2db3b00e978d5fa959ab4143cd3435268a8`; its second parent is the requested
beta. Both are ancestors; the merge was clean and prior reviews are preserved. The
merged controller-interface spec matches beta, and the merge changes no source or tests.
The worktree was clean before the update.

## Decisions and review implications

- **Stuck ACP connect/reconnect:** accepted as today's behavior and a named exception
  to bounded waits, limited to the existing ACP lifecycle. The earlier P1 at
  `11-12-REVIEW-A2.md` third follow-up remains evidence of the hang, but its owner
  decision is now supplied; it is not by itself a reason to demand a source fix in A2.
  The accepted design still must fail the triggering prompt promptly on rejected send
  and keep the queue waiting for the existing reconnect so reconnects do not overlap.
  The future fix is `library/todos/11-13-TODO-cancellable-provider-connect.md`; this
  exception does not authorize other unbounded waits.
- **Snapshot order:** exactly two cross-stream pairs may be accepted in either order:
  metering versus the same turn's last managed presentation event, and metering versus
  the same turn's last Agent-owned in-progress assistant snapshot record. The dedicated
  test/snapshot exception must keep all other content, IDs, within-stream order and
  sequence requirements strict, and explicitly assert the contractual orders in the
  task/spec. The earlier isolated `cause` addition remains the only other exception.
  Specific-sequence cases use bounded event barriers; unrelated sorting or normalization
  is not authorized.
- **Comparative evidence:** the implementer must compare affected cases about 50 times
  each on A1 and A2, count each order and other failures, explain comparability,
  instrumentation and noise, and investigate a noticeable shift without asserting
  that small samples prove equal rates. The final review will inspect the raw method,
  assertions, narrow diff and evidence when assigned.

I read the beta diff, the updated spec decisions, the complete metering-order finding,
and the cancellable-connect TODO. No test suite was run for the documentation-only
merge. The earlier A2 follow-up report contains the most recent independent full-suite
result. No implementation checkout, reviewer source edit, live harness, push, merge
into beta, or protected path/worktree/process change occurred. Await the coordinator's
assignment to review the final A2 commit; B1 remains held.
