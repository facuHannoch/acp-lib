# A2 review preparation: corrected turn-event contract

Assignment: `controller-interface-status` commit `bef318c`,
`.plan-execution/tasks/controller-interface-A2-correction.md`.

Merged beta `fcd1fd49b6bf844724fb86a3040b0866e0ec4488` into
`controller-interface-reviews` in merge commit `d902898f9306898e0e3d0711f72b18e2aba2fe5e`.
The merge was clean. Its first parent is prior review preparation
`7a64c575d8d56acf90a5ec6d3394675e52a9921a`; its second parent is the requested beta.
Both commits are ancestors, preserving the A1 reviews and A2 preparation.

The corrected `library/11-11-SPEC-controller-interface.md:232` now permits the
controller to report `turn_started` and, for backend-scheduled controllers,
`turn_took`, while leaving turn outcomes to the prepared turn and session. This
resolves the exclusivity wording contradiction in
`11-12-REVIEW-A2-PREPARATION.md`; that earlier report is retained as history.
The separate `subscgentribe` typo at spec line 350 is already acknowledged in the
assignment and has no contract effect. No spec file was edited by the reviewer.

Verification: the merged spec matches the requested beta commit; no source or test
changes resulted from the merge, and the worktree was clean before the merge. No test
suite was run for this documentation-only update. No implementation branch checkout,
source edits, live harness, push, merge into beta, or protected path/worktree/process
changes occurred. Await the coordinator's A2 review assignment; the implementer's
steps 2–4 remain held until the coordinator confirms both beta updates. Existing
snapshot and visible error-string restrictions remain in force.
