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

Clad declined Gate 2 at `07fa2d1e32f8313de98c69d8aa87089d8d87a976`.
Both typechecks, 331 harness tests, and 67 native tests passed independently.
The review found that focused reads still transferred the model metadata
blob, that reply identity used a per-row lookup into that blob, and that
tracked turns lost their linked items. It also requested a committed query
plan regression.

The follow-up limits the SQLite scalar metadata query to explicit keys and
joins reserved reply IDs by their indexed entry sequence. The side table is
populated transactionally on response commit and import. Open backfills it
on upgrade or after an older writer changes the original model record. The
schema version and positional entries INSERT are unchanged. Clean reopen
skips the model blob when there is no abandoned running turn. Recovery of an
abandoned running turn still loads the model record to close its attempts.

A SQLite regression observes the actual range SQL and query plans after
seeding 10,000 model-call records, and verifies that clean reopen, observation,
reconciliation and paging do not select the model blob. Shared adapter
conformance now checks tracked turns' linked inputs. The host falls back to
the status revision for channels it did not observe, and live and paged
positions share one encoder. The submission store deletes settled entries,
so startup batches cover outstanding submissions. The mixed workload scale
checkpoint remains in Gate 4. Tests also check that policy deny prevents
notify_channel dispatch and that the built-in name cannot be shadowed.

The first broad fix run passed 333 tests with one failure. Fresh SQLite create
left an owner journal because the reply-ID projection was initialized after
publication. Initialization now finishes in the draft transaction. Both the
journal regression and the bounded-read regression passed in isolation.

The Gate 2 follow-up containing this entry passed both package typechecks.
Serial harness verification (`bun test ./test --timeout 30000`) passed
334 tests with 3595 assertions across 45 files. Root `bun test ./test/native`
passed 67 tests with 6423 assertions across 6 files. Both suites had zero
failures. Independent re-review is pending.

Clad approved Gate 2 at `47a0c1802d2d5aadc63586ad48ab7e26d3aa797e`.
Independent verification passed both typechecks, 334 harness tests, and 67
native tests. A clean SQLite reopen skips the model metadata. Repair after
an abandoned running turn still loads the metadata once in its recovery
transaction to close running attempts. The mixed workload checkpoint remains
for Gate 4.

Gate 3 begins from the approved revision.

Gate 3 shares observation and targeted recovery between process reopen and
attachment. The host exposes lifecycle commands, negotiated capabilities,
status freshness, a working-channel count, and partial usage. Attachment
disposal leaves backend work in place. The configured host responder keeps
answer authority across detach and deduplicates pending requests; the
conversation handler remains the fallback. Restart composes confirmed
exact-turn interruption and start, and fails before start on an unconfirmed
stop. Existing acp-client transcript reads stay on their existing path.
Harness history and catch-up are explicit. The catch-up consumer commits
each page with its position and owns the durable transaction. The real stdio
operator checkpoint and mixed workload proof remain in Gate 4.

The Gate 3 submission containing this entry passed both package typechecks.
The combined native and persisted transcript reader gate
(`bun test ./test/native test/persistence-transcript-reader.test.ts`) passed
79 tests with zero failures and 6497 assertions across seven files.
Independent review is pending.
