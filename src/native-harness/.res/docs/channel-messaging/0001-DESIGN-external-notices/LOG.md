# External notices work log

Branch `aiagent/cod1a-external-notices` starts at
`4d341ddc8fc2016acc2468d93134bc32db959102`. Clad owns independent review.
Decision 0025 and the harness contract types are the first gate.

## Worker recovery prerequisite

The pinned tree's orchestrator spec describes workers as ordinary external
ACP conversations, including Codex and Claude. Its workers repository and
assignment correlation are design seams. The pinned source tree has no
committed orchestrator implementation or assignment-indexed worker result
repository. The actual ACP client opens or reloads by provider session ID
in `src/client.ts`, and `AgentSession.promptFrom` returns a locally allocated
prompt handle. The Agent persistence interface can query recorded operations
by operation ID, but that does not recover a backend completion lost before
acp-client records it. No named backend on this base exposes a supported
terminal-result recovery or acknowledgment operation by assignment ID.

The required replacement-process proof is unavailable on this revision.
Conversation reload and local transcript inspection do not establish it.
Generic channel/notify can proceed after independent contract approval.
Worker-dependent staging, delivery and public acceptance stay open until
the orchestrator workstream identifies and proves the supported recovery
backend. No orchestrator worktree was modified.

Both package typechecks were run on the contract-only tree. Each reports
eight errors in existing consumers still missing the new operation or
writing the previous format. Implementation will update those consumers
after contract approval. No runtime paths have changed.

Clad declined Gate 1 at `09c7e3dfa5382940015d3f15e768558dd447f569`
because session drain admission needed an explicit external-notice rule.
The follow-up pins the full validation order, duplicate lookup before the
inspection fence, rejection of reserved inherited names, and the format 6
columns and migration. Both typechecks still report the same eight
expected contract-only errors. Worker recovery remains unproven on the
pinned backend. Independent re-review is pending.

Clad approved Gate 1 at `56285d81d0e53f8ec54590fb7ab5ec433a011b39`
after confirming the same eight contract-only errors in both packages.

## Generic Gate 2

Storage, archive and context rendering landed in
`131ad3a1ee7539b6f86b917d0fea5797f04739f4`, before the dependent scheduler
and wire changes. The format 6 migration adds nullable attribution columns
and preserves existing format 5 signatures. SQLite and memory share
admission, signature and policy composition. A known external ID returns
its recorded receipt before the execution fence even on an inspection
open. Archives preserve the submitted inherited set, attributed item and
matching timeline entry. Protocol delivery uses ordinary wake and take.

Shared storage coverage checks conflicts, set normalization, admission
during drain, the internal notice exception, inspection-only duplicate
receipts with unchanged revision, and pending/taken archive round trips.
The format 5 SQLite fixture has no external columns before upgrade.
A golden context test pins user-role rendering with external attribution.
Both transports exercise detached wake and active-turn steering with
inherited denial, timeline attribution and conversation counting.
The real child receipt-loss test kills after inbox acceptance and retries
over a fresh connection.

The coordinator and reviewer confirmed that worker recovery is still
unproven. A native worker conversation is only a candidate. The stable
assignment-to-input mapping and recovery after completion before staging
are unimplemented and unapproved. ACP replay has no equivalent proof.
No worker staging or orchestration changes are included. Worker Gates 3
and 4 remain open. Haurness-l coordinates backend selection.

Generic Gate 2 verification passed both package typechecks. Full harness
`bun test ./test --timeout 30000` passed 360 tests with 3777 assertions
across 47 files. Root `bun test ./test/native` passed 87 tests with 6576
assertions across seven files. Both suites had zero failures. Independent
review of the generic harness behavior is pending.

## Generic closure and retrospective

Clad approved generic Gate 2 at `f5220726f55320a1df214e5ebe46cdd5e260f548`,
with storage and rendering at `131ad3a1ee7539b6f86b917d0fea5797f04739f4`
and the approved contract at `56285d81d0e53f8ec54590fb7ab5ec433a011b39`.
The clean detached review passed both typechecks, 360 harness tests
(`bun test ./test --timeout 30000`) and 1422 root tests
(`bun test ./test`), with zero failures.

The contract review separated new notice admission from replay and pinned
the external drain refusal. Storage conformance then verified that replay
keeps the original receipt across suspension, incompatible inspection,
and archive import. A real stdio crash after inbox acceptance verified one
take and one model call on recovery. The format 5 upgrade preserves item
signatures, and format 6 prevents older readers from taking unfamiliar
notice records.

The endpoint with the open session owns notice authority. The current
protocol uses one endpoint per session. After stop, checking an inbox ID
uses a full storage snapshot. This is an accepted cost on that rare path.

Worker Gates 3 and 4 remain open. The accepted receipt-loss result covers
harness inbox recovery. A supported worker backend still needs independent
proof of completion recovery by assignment ID after lost delivery before
staging. Assignment correlation, backend selection, and the worker staging
transaction remain with the orchestrator workstream. Haurness-l coordinates
that dependency.

## ACP worker recovery prerequisite

Base `5274d5466e81e0ff27f9dbf4bab8ba0ddb547393` amends the recovery
boundary to use finalized ACP worker conversation records. The proof uses
the production Agent lifecycle, SQLite persistence and stdio ACP transport
with deterministic fixture peers. It adds no schema or runtime changes
and does not touch the R1–R3 integration files.

Before ACP dispatch, the Agent persists the user record with its operation
ID and consumer metadata. The fixture uses that metadata for the assignment
ID, destination and originating policy names. The supervisor kills and
reaps the Agent process after the final commit and inspects SQLite before
starting a replacement. The replacement uses only stored operation and
conversation records and has no runnable ACP command. It recovers the
same final record ID, exact response and provenance on repeated lookup.
An unknown assignment returns no match. A second case kills after a
provider chunk and before finalization. The mapping survives, but no
completed result is available.

Run `bun test test/worker-recovery-process.test.ts` from the repo root.
The lookup is a test fixture scoped to one conversation and one page.
No live provider was exercised. The post-prompt kill covers the finalized
operation and its completion evidence together, with no result staged
for delivery. It does not cover every intermediate persistence write
or implement uncertainty staging. Worker delivery remains open pending
independent review and subsequent staging and delivery gates.

Verification under normal local subprocess permissions passed three serial
runs of the focused test (2 tests and 28 assertions per run) and both
package typechecks. The restricted sandbox did not finish the ACP prompt;
the successful runs used local process escalation.

## Production worker handoff contract gate

Clad independently ran the two process-death tests at
`8fd669711290a5290df40050be52959f4ecf229e` three times (2/0 each).
Haurness-l accepted that revision as a feasibility proof of the Agent
saved-record boundary. The fixture lookup scans conversations and the
first 100 records of each. It does not establish production indexed
correlation, strict pre-dispatch persistence, uncertainty staging, or
live-provider semantics.

Decision 0025 now specifies the production binding, staging and retry
contract and the process-death gates. This revision changes documentation
only. Core coordination for the implementation base, owned files and
schema allocation remains pending. Worker delivery acceptance remains open.

Clad withheld contract approval at `c6d4198`. The revision adds the Agent
owner-lock rule, finalization versus uncertainty commit ordering, the
redirect policy union, explicit delivery transitions, and the optional
backend recovery hook. Typed Agent repository contracts and shared
conformance remain required before runtime changes, after coordination
with Core. No runtime behavior changed.

The follow-up adds the standalone typed contract in
`src/persistence/worker-delivery-contract.ts`. Placement does not claim a
schema version or change any existing adapter. The repository stages by ID
so the final-record recheck belongs inside the write transaction.

Clad approved the contract at `89f873dae1c221f0889641ef1cde3a46314d41cb`.
Merge `b3c9be8` carries that history onto Core's R1 base `a902ccf`.
Core assigned Agent schema 18 and authorized the single finalization call
in the existing Agent transaction. The first repository commit is
`5ec4cf004374e055610cdc3d702e11bc4d374193`.

The repository stores a final record pointer in the conversation commit
and reads the result from the conversation records when staging. Before
staging, the assignment contains no separate copy of the result bytes.
Both typechecks and 34 focused repository/SQLite persistence tests passed.
The process-death tests are prepared against Core's beforeDispatch hook.
On this base the peer rejects both prompts at receipt because the binding
has not committed. This is expected until the reviewed hook is merged.
The production process-death gate and full suite are still pending.

Core's review of the prerequisite hook found that a pre-dispatch ID cannot
in general be the final turn operation ID. The proposed contract binds each
assignment to its worker and submitted message before dispatch. Completion
correlates via the turn's causal message IDs and stores the final operation
and record pointers in the final-record transaction. This supports folded
messages sharing a final operation. Runtime changes await independent
review of this amendment and Core's reviewed hook.

The follow-up to `723c179` adds the policy union across folded bindings,
terminal uncertainty staging for failed or interrupted operations under
the live owner, and typed causal message correlation. Root typecheck
reports the expected contract-first errors in existing consumers until
the repository and both lifecycle hooks are updated.

Haurness-l confirmed that folded notices carry the complete causal policy
union. The live terminal outcome is failed, including explicit
cancellation, with a notice stating that the worker did not complete the
assignment. Abandoned work without reliable final evidence is uncertain.
The failure hook uses causal message IDs in the transaction that records
the terminal operation. Core coordination covers this lifecycle seam.

The spec owner refined the observed terminal contract after `06ff532`.
Failure and interruption now carry distinct kinds, the terminal reason
and a possible-partial-effects flag. Crash uncertainty remains reserved
for work without reliable terminal evidence. Independent contract review
and the reviewed causal hook are still pending.

Clad approved the distinct terminal outcome contract at `de82940`.
Haurness-l then pinned bounded, non-secret reasons and the partial-effects
warning. The contract uses fixed public text from recognized terminal
signals with explicit generic fallbacks, and tests that untrusted raw
provider text stays out of the persisted outcome and notice.

## Production repository and process-death verification

Merge `56ac47a` brings in Core's reviewed causal hook at `7be9456`.
Runtime `c21c6bf43bb7130267975b4de5cdb78565f1d8a5` binds the submitted
message before dispatch and attaches the operation and final record in
the worker's terminal transaction. The feasibility test update at
`59e75545a02351ba0769d56f4d8be9a243c7d551` checks the new table is empty.

The fixed reason mapping uses typed stalls, forced stops and recognized
interrupt or steering signals. Unclassified failures use "worker failed".
Cancellation without a recognized signal uses "worker interrupted",
including native. Dispatch history cannot rule out effects on these
lifecycle inputs, so the outcome records possible partial effects.

Both typechecks passed. The focused gate passed 9 tests and 147
assertions. The ACP fixture checks the indexed binding on disk at prompt
receipt. The final and partial SIGKILL cases inspect the database before
replacement, then recover by assignment ID using the repository with an
undispatchable adapter. They assert one stable pending notice, the exact
final result or uncertainty, and immutable staging even after a late
terminal record. Live fixture failure and targeted interruption exercise
the lifecycle commits. Folded success and failure are checked through
the repository with separate destinations and a shared policy union.

The retry check exercises repeated repository staging with identical
payload and ID, then the receipt state transition. Actual host outbox
flush and acknowledgement loss over the wire belong to the orchestrator
integration gate. No live ACP provider was exercised.

Full verification on runtime parent `59e7554` passed root
`bun test ./test` (1457/0, 35 snapshots, 135 files) and harness
`bun test ./test --timeout 30000` (360/0, 47 files), using normal local
subprocess permissions. The initial root run exposed the original
feasibility assertion that the assignment table must not exist; the
corrected test checks that the table contains no rows. Independent
implementation review is pending.

## Worker repository closure

Clad approved the repository and lifecycle gate at
`b53abf2cf04f7848921dab59be74e26cb08a2f3c`, with runtime at
`59e75545a02351ba0769d56f4d8be9a243c7d551`. Independent verification on
a clean detached checkout passed both typechecks, the full root suite
(1457/0), the full harness suite (360/0), and three consecutive focused
worker runs (9/0 each). This closes the repository gate under the contract
approved through `57769e522bf76e5945d840273fa7dbe78dcf3a62`.

The feasibility proof established the saved-record boundary. The
production gate added indexed causal correlation, a binding checked
at ACP prompt receipt, and terminal settlement with safe reasons
and the folded policy union. The two SIGKILL cases exercised the actual
Agent and SQLite path with deterministic ACP peers. No live provider
was exercised.

The exclusive owner lock prevents a replacement from staging uncertainty
while the previous owner can still finalize. The final pointer commits
with the conversation records, and staging rechecks it in a write
transaction. The tests cover both crash sides and immutability after
late evidence. They do not race competing finalization and staging
transactions directly.

Worker configurations that need exact result text must retain assistant
message content. The process tests enable content capture. With capture
disabled or redacted, the saved record may lack the result text, and
this gate does not verify exact recovery in that mode.

Stable retry was verified at the repository boundary. The orchestrator
integration gate still owns host flushing through channel/notify,
lost wire acknowledgements, and retries after resume or earlier channel
changes. Haurness-l coordinates integration and merge order.

## Final R1 compatibility verification

Merged Core's reviewed R1 `70ba71a` in `395d337`, then the final
pre-alpha base `a180301` in `b5418f60c7d096f7b753606c2a5efc4c0ac4c0fb`.
The schema conflict resolution retains R1's nullable controller-kind
repair and the additive worker assignment table in the same migration
transaction. Schema 18 accepts final and early schema 17. Fixture tests
cover 16, final 17, and early 17 without the column. Existing native
kind survives, and databases without the column gain a nullable kind.
Each fixture exercises the worker repository after migration.

Both typechecks passed. Focused migration, persistence and worker
replacement tests passed 43/0. The full harness suite passed 360/0.
The first full root run, concurrent with the harness suite, passed
1472 tests with one audit flush timeout. The audit file passed 12/0
in isolation. No timeout settings were changed.

The full serial root rerun on the merged runtime passed 1473/0 across
135 files, with 35 snapshots. The combined branch is ready for independent
delta review. Worker delivery has not been merged into alpha.

Clad independently approved `d403bf40c13cdb910f1d302e643997b046978af8`
(runtime `b5418f6`). Both typechecks, the serial root suite (1473/0)
and two focused runs (43/0 each) passed. The first harness run had one
invalid-batch test failure (359/1). The case passed three isolated runs,
and the full harness rerun passed 360/0. The parallel audit flush timeout
and the harness case were load-sensitive in these runs. Neither test or
its timeout settings changed in this delta. The same on-open column
repair also covers pre-merge schema 18 databases missing controller kind.
Haurness-l owns integration into alpha.

## Gate 3 amendment contract

Branch `aiagent/cod1a-worker-delivery-amendment` starts at alpha
`3fd2db2` with the plan cherry-pick `8abd58d` from `2b63dc2`.
The contract adds steer continuation, typed destinations and immutable
worker handles, bounded recovery, final-message projection and delivery
acknowledgement rules. No runtime changes. Core retains schema 19 and
shared host/orchestrator integration. Migration allocation and an ACP
durable acceptance seam remain to be coordinated before implementation.

## Gate 3 implementation evidence

Core's reviewed O1 base `3c28130` was merged at `447c1bb`; alpha was
confirmed at `3c28130` before schema 20 integration. Clad approved the
steer and delivery contract at `18df7e1` and the atomic explicit
replacement addition at `88ef0fb82426f00061ba58592c34e8b41ee71778`.

Runtime `f5800693b8eeefd458e843684922dac91513b470` implements
schema 20, indexed reads, continuation and replacement transactions,
last-assistant-message projection, terminal lifecycle hooks and
native host flush. `2fb1bcf4923788c23c18867cfaae986ae2afeb74` adds
process-crash assertions. The discovery query walks separate indexed
ranges for finalized rows and the unfinished rows from prior owners,
using the reservation sequence at open to exclude current-owner work.

A database created by the actual `3fd2db2` SQLite adapter with a pending
notice was opened by archived `3c28130`, then by schema 20 twice. The
delivery ID, native destination and fallback source were preserved and
the stored staged JSON was byte-identical. The migration suite also
covers the version 16 chain and the existing worker and conversation
records.

The real stdio tests kill the harness after notice acceptance and
before its reply. Reopen retries the same ID and records one external
notice. They also verify startup suspension before flush, delivery
after resume, ACP destinations excluded from native flush, invalid
policy blocking and explicit retry, and terminal missing destinations.
An offline ACP fixture worker completes before host startup and wakes
a detached native destination. The external notice is excluded from
conversation message paging. Another ACP fixture folds two steer
messages into one successor and confirms one staged result.
Repository tests cover the final projection, missing or blank output,
immutable staged redirects, duplicate continuation and replacement,
and a stale predecessor. Process tests kill before the final record,
after final commit but before staging, after staging, before and
after successor linkage, and before replacement transaction commit.

The explicit new-assignment orchestration call and ACP idempotent
append belong to O3a. The native test calls the same public flush
method after replacement; it does not run O3a. Fixture ACP peers cover
offline record semantics; no live ACP provider was exercised. The test
for post-stage owner death and the real stdio lost-receipt test are
separate cases. A single driven orchestrator public checkpoint remains
for the integrated workstreams.

Both typechecks passed. The focused migration, repository, process and
native suite passed 52/0 before the last boundary tests. The final
worker process and native tests passed again in the 24/0 rerun with
the audit file. The full serial harness suite passed 360/0.

The full root gate remains open. The overlapping root and harness runs
reported three existing native stdio timeouts and one harness restart
timeout respectively. The serial root run reached 1528/2 (1530 tests),
with default five-second test timeouts in checkpoint persistence and
the schema 16 worker migration. Those files passed 10/0 in isolation.
The final serial root run with a runner-only timeout of 30000 ms
reached 1527/3 (1530 tests). The audit flush timed out and two worker
fixture children hit their own watchdogs (partial SIGKILL and live ACP
interrupt). The audit and both worker files passed together 24/0 in
the focused rerun. No source timeout settings were changed, and no
full root pass is claimed. Independent review is requested with this
verification caveat.

The root gate subsequently passed on a clean archive of
`d78bee1698cf619ccfaa48620a64556d30d3fbe9`. The O1 baseline
`3c28130` and candidate ran back to back with the same installed
dependencies, `bun test ./test` and separate RAM-backed temp directories
on the same filesystem. Baseline passed 1521/0 (140 files, 158.76 s).
Candidate passed 1530/0 (141 files, 159.98 s). Each reported 35 snapshots.
Neither reproduced the earlier audit timeout under these run conditions.
No test, client or runtime timeout changes were needed.

Clad withheld approval of `d78bee1` because replacing an abandoned ACP
binding returned conflict until a separate caller staged it. The fix
stages that predecessor's uncertainty and reserves its replacement in
one transaction, with the persisted old_settled disposition. The
reopen and process tests cover one immutable ACP uncertainty notice and
idempotent replacement without a native flush.

Final result projection uses the final assistant record's stored
`search_text`, produced by `contentText`. Its projection can include
image alt text, resource titles or text, and structured JSON. Those
strings can make the projection nonblank. Delivery-induced connection
loss with pending work uses the host restart budget. A notice that
repeatedly crashes the harness can exhaust that budget and fail the
host while its durable record stays available. A continuation of an
abandoned assignment conflicts. Core's orchestrator must reserve fresh
work, using atomic replacement where appropriate.

Verified the fix at `1ae9a90963856d5380ae09d92983708a980a00ff` on a clean
archive with RAM-backed test temporary storage. Both typechecks passed.
Focused worker, migration and native delivery tests passed 57/0 across
six files, including the abandoned ACP SIGKILL case. The exact root
`bun test ./test` passed 1530/0 (141 files, 35 snapshots, 173.44 s).
The harness `bun test ./test --timeout 30000` passed 360/0 (47 files,
34.70 s). No timeout settings changed. The earlier failures remain
recorded above, and this successful gate does not by itself isolate
machine load from the effect of the temporary filesystem.
