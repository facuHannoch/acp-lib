# Operator controls work log

Branch aiagent/cod1a-operator-controls starts at 3585cf3 with alpha 9d1964d,
ACP integration 7133c5c and callbacks f4eff94 with closure c1c3e88.
Gate 1 is contract and decision only. Clad independently reviews each named
gate before dependent implementation begins.

Both package typechecks passed. The proposed method and storage read types
are separate from the active dispatch map until implementation.

Clad requested changes at 89fe68c. The follow-up specifies approval closure
on the event union, observe response ordering including ephemeral events,
participant identity and live positions, session lifecycle in observation,
indexed range bounds, and explicit wire replacement and validation behavior.
Both package typechecks passed again. Gate 2 awaits independent approval.

Clad approved Gate 1 at 6f04767fbdd240f6f685a70ff3fb47d41d839916
after independently passing both package typechecks.

Gate 2 in progress. The first shared adapter conformance case passed on
memory and SQLite (2 tests, 16 assertions), and harness typecheck passed.
SQLite uses partial indexes over existing entry columns and JSON expressions
to preserve the previous revision's positional INSERT. Index installation
runs in the open transaction. Protocol replacement, live position and
approval publication, and the remaining tests are still pending.

Gate 2 checkpoint. The endpoint now advertises and serves focused open,
observe, reconcile and history and refuses legacy load and messages. Focused
wire/storage checks passed on both transports and both adapters (4 tests,
42 assertions). Both package typechecks passed. The previous broad harness
run was before the cutover and reported 319 pass and 10 fail. Several
catalog and event expectation fixes passed in the focused 24-test run.

The runtime cutover exposes a gate sequencing dependency. The current native
host still requires session/load and pages session/messages. Fifteen harness
test files also call the old methods. The old typed methods are still present
for those callers. This checkpoint is not submitted as a passing Gate 2.

The coordinator approved moving the minimal native host cutover from Gate 3
into Gate 2 because supported open and recovery depend on the replacement
wire methods. The host now opens, observes channel state, and reconciles
tracked IDs without draining history pages. Harness fixtures were migrated
off the removed wire methods. Host controls, responder routing, attachment
handling, recovery extraction, and explicit history and catch-up stay in
Gate 3.

The guarded open test prohibits full snapshots during startup channel changes,
observation, and reconciliation. SQLite EXPLAIN QUERY PLAN for the range
predicates reports `entries_conversation` for channel conversation pages,
`entries_replies` for turn replies, and the integer primary key for global
timeline pages. Public tests cover both transports, oversized records,
position scope and identity, approval observation and closure, and real stdio
notice delivery to an unattached channel. The 10,000-record public checkpoint
remains in Gate 4.

Gate 2 submission is the revision containing this entry, based on checkpoint
`cf90755d2ad84db118ddfe1b8324fa627f49b2d7`. Serial verification passed
`bun run typecheck --pretty false` in both packages, harness
`bun test ./test --timeout 30000` (331 pass, 0 fail, 3574 assertions, 45
files), and root `bun test ./test/native` (67 pass, 0 fail, 6423 assertions,
6 files). The harness run used a 30-second test runner budget. Runtime
protocol deadlines are unchanged. Independent review is pending.
