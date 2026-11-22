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
