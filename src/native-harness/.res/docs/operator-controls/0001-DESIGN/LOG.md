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

Clad approved Gate 3 at `d107412cebc90380a5e8a43638ce1e5a1c1bf113`.
Independent verification passed both typechecks, 334 harness tests, 79
native and transcript tests, and 1405 root tests. Explicit usage requests
page the whole model-call history even when filtering by channel. This
remains a known limit, along with the model record read during abandoned-turn
recovery.

Gate 4 extends the real-stdio checkpoint with the shared Agent rig and scripted
SQLite child. The cases cover a completion while Alice reattaches and Bob
keeps receiving events, notice delivery to unattached Alice, pending approval
recovery without a second responder, and Restart losing its connection before
confirmation. The callback checkpoint covers responsive status and stop
during suspension, clean replacement, and explicit resume with Bob still
individually suspended. Tests distinguish attachment connectivity, channel
lifecycle, session lifecycle, and process state, and verify two working
channels while both have running turns.

The scale fixture has 10,000 assistant and tool timeline records and 5,000
turns whose legacy projection exceeds one frame. Under held inference, clean
open, attachment, and tracked reconciliation add no storage snapshots and
issue no history requests. Model context assembly itself still reads storage.
Explicit history pages stay channel-scoped and tool activity stays in the
timeline. Paging advances past an omitted oversized result. The loss fixture
kills the child after a reply commits, interrupts catch-up between pages,
and retries from the consumer's persisted position while live delivery
continues. The consumer owns its page transaction and message-ID deduplication.

The CLI snapshot counter is opt-in for the offline test. It leaves the
production storage path unchanged when the test environment variable is
absent. The checkpoint file retains the shared Agent rig and control
barriers used by the prior real-process cases.

The Gate 4 submission containing this entry passed both package typechecks.
Serial harness verification (`bun test ./test --timeout 30000`) passed 334
tests and 3595 assertions across 45 files. Full root `bun test ./test` passed
1411 tests, 12054 assertions and 35 snapshots across 131 files, including all
six new real-stdio operator cases. Both suites had zero failures.
Independent review is pending.

## Closure and retrospective

Clad approved Gate 4 and the operator controls slice at
`95670a277aa1f2461e37e3fe3cb798edb0952f0d`. The independent clean-checkout
gate passed both typechecks, all 334 harness tests with
`bun test ./test --timeout 30000`, and all 1,411 root tests with
`bun test ./test`. The root run included all six real-stdio operator
checkpoints. The reviewer confirmed that the snapshot counter measures actual
successful storage snapshot calls.

The accepted chain starts at base `3585cf3`. Gate 1 approved the contract at
`6f04767fbdd240f6f685a70ff3fb47d41d839916`. Gate 2 approved the focused
protocol and SQLite reads at `47a0c1802d2d5aadc63586ad48ab7e26d3aa797e`.
Gate 3 approved host controls and attachment at
`d107412cebc90380a5e8a43638ce1e5a1c1bf113`. Gate 4 is the accepted behavior
revision. This closure records that approval without changing behavior.

Moving the minimal host cutover into Gate 2 kept the wire replacement and
its existing consumers on the same verification gate. Review found that
indexed entry ranges still depended on parsing the large model metadata
record. The scalar metadata query, sequence-keyed reply ID projection, and
committed query-plan regression closed that gap. Real stdio barriers then
verified observation and recovery while another channel could continue,
as well as durable catch-up after losing a stream.

Accepted limits and coverage caveats

- Explicit usage reads scan every model-call page, including when scoped to
  a channel.
- Repair of an abandoned running turn reads the full model metadata record
  once during recovery. Clean reopen skips that record.
- Inference context assembly reads a full snapshot per inference, with a cost
  that grows with history. The 10,000-record gate measured open, observe,
  paging, and targeted recovery separately from that inference work.
- Catch-up callers own the durable commit of each page and its position, and
  use stable message IDs to deduplicate.
- The 10,000-record fixture pages backward after the held turn is
  interrupted. The reattachment and catch-up tests cover the overlap with
  live delivery.
- The unconfirmed Restart checkpoint exercises connection loss before
  interruption confirmation.
